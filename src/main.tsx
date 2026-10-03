import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod'
import { calculateStaticLoad, findMinimumVehicleSize, PlacementService, SpeechService } from './services'
import { useLoadPlanStore } from './store'
import type { CheckStatus, CargoGroup, LoadPlan } from './types'
import './styles.css'

const numberField = z.preprocess(v => typeof v === 'string' ? Number(v.replace(',', '.')) : v, z.number().finite())
const optionalNumberField = z.preprocess(
  v => v === '' || v === undefined ? undefined : typeof v === 'string' ? Number(v.replace(',', '.')) : v,
  z.number().finite().optional(),
)
const optionalNonNegativeNumberField = z.preprocess(
  v => v === '' || v === undefined ? undefined : typeof v === 'string' ? Number(v.replace(',', '.')) : v,
  z.number().finite().min(0).optional(),
)
const cargoGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  length: numberField.pipe(z.number().min(0.01)),
  width: numberField.pipe(z.number().min(0.01)),
  height: numberField.pipe(z.number().min(0)),
  weight: numberField.pipe(z.number().min(1)),
  count: z.coerce.number().int().min(1).max(100),
  rotatable: z.boolean(),
  stackable: z.boolean().default(false),
})
const schema = z.object({
  vehicleLength: numberField.pipe(z.number().min(0.1)), vehicleWidth: numberField.pipe(z.number().min(0.1)), vehicleHeight: numberField.pipe(z.number().min(0.1)),
  coolerLength: numberField.pipe(z.number().min(0.01)), coolerHeight: numberField.pipe(z.number().min(0.01)), coolerProjection: numberField.pipe(z.number().min(0.01)),
  payloadCapacityKg: optionalNumberField, doorWidth: numberField.pipe(z.number().min(0)), gap: numberField.pipe(z.number().min(0)),
  hasObstacle: z.boolean(),
  obstacleMode: z.enum(['AUTO', 'FIXED']),
  obstacleWeight: optionalNonNegativeNumberField,
  obstacleX: numberField.pipe(z.number().min(0)), obstacleY: numberField.pipe(z.number().min(0)), obstacleLength: numberField.pipe(z.number().min(0)), obstacleWidth: numberField.pipe(z.number().min(0)),
  unavailable: z.boolean(), unavailableX: numberField.pipe(z.number().min(0)), unavailableY: numberField.pipe(z.number().min(0)), unavailableLength: numberField.pipe(z.number().min(0)), unavailableWidth: numberField.pipe(z.number().min(0)),
  axleCount: z.coerce.number().int().min(0).max(8),
  axleMode: z.enum(['AUTO', 'FIXED']),
  axlePositions: z.array(numberField.pipe(z.number().min(0))).length(8),
  axleCapacitiesKg: z.array(optionalNonNegativeNumberField).length(8),
  cargoGroups: z.array(cargoGroupSchema).min(1).max(8),
}).superRefine((value, ctx) => {
  if (value.axleMode !== 'FIXED') return
  const count = Math.max(2, value.axleCount)
  const positions = value.axlePositions.slice(0, count)
  if (positions.length < count) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['axlePositions'], message: 'Укажите положение каждой оси.' })
    return
  }
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i] > value.vehicleLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['axlePositions', i], message: 'Ось должна находиться внутри длины кузова.' })
    }
    if (i > 0 && positions[i] >= positions[i - 1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['axlePositions', i], message: 'Оси указываются от кабины к задней части: координата должна уменьшаться.' })
    }
  }
})
type FormValues = z.infer<typeof schema>
const statusClass: Record<CheckStatus, string> = { CHECKED: 'status-ok', VIOLATION: 'status-bad', NOT_CHECKED: 'status-idle', CALCULATED: 'status-calculated' }
const statusText: Record<CheckStatus, string> = { CHECKED: 'ПРОВЕРЕНО', VIOLATION: 'НАРУШЕНИЕ', NOT_CHECKED: 'НЕ ПРОВЕРЕНО', CALCULATED: 'РАССЧИТАНО' }
const getLoadGeometry = (plan: LoadPlan) => {
  const sortedAxles = plan.axles.slice().sort((a, b) => a.position - b.position)
  const automatic = plan.axles.length < 2 || plan.axles.some(axle => axle.source === 'AUTO')
  const analysis = calculateStaticLoad(plan)
  const axlePositions = analysis.axlePositions.length >= 2
    ? analysis.axlePositions
    : [plan.vehicleLength * 0.70, plan.vehicleLength * 0.90]
  const axleLoads = !automatic && analysis.valid
    ? sortedAxles.map((axle, index) => {
        const loadKg = analysis.axleLoads[index]
        const percent = analysis.totalWeight > 0 ? loadKg / analysis.totalWeight * 100 : null
        return {
          ...axle,
          axleNumber: axlePositions.length === 2 ? (index === 1 ? 1 : 2) : index + 1,
          role: axlePositions.length === 2 ? (index === 1 ? 'передняя / рулевая' : 'задняя / ведущая') : '',
          loadKg,
          percent,
          overCapacity: axle.capacityKg > 0 ? loadKg > axle.capacityKg : false,
        }
      })
    : sortedAxles.map((axle, index) => ({
        ...axle,
        axleNumber: axlePositions.length === 2 ? (index === 1 ? 1 : 2) : index + 1,
        role: axlePositions.length === 2 ? (index === 1 ? 'передняя / рулевая' : 'задняя / ведущая') : '',
        loadKg: null,
        percent: null,
        overCapacity: false,
      }))
  return {
    axlePositions,
    axleLoads,
    cgX: analysis.cgX,
    cgY: analysis.cgY,
    totalWeight: analysis.totalWeight,
    assumed: automatic,
    loadModelValid: analysis.valid,
  }
}
const presets = [
  ['EUR 1,2 × 0,8 м', 1.2, 0.8], ['1,2 × 1,0 м', 1.2, 1.0], ['1,2 × 1,2 м', 1.2, 1.2], ['Свои размеры', 0, 0],
] as const

function Field({ label, input, error }: { label: string; input: ReactNode; error?: string }) {
  return <label className="field"><span>{label}</span>{input}{error && <em>{error}</em>}</label>
}

function PlanForm() {
  const setPlanVariants = useLoadPlanStore(s => s.setPlanVariants)
  const [listening, setListening] = useState(false)
  const [recognized, setRecognized] = useState('')
  const { register, handleSubmit, setValue, watch, control, formState: { errors } } = useForm<z.input<typeof schema>, any, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      vehicleLength: 6, vehicleWidth: 2.05, vehicleHeight: 2.2, coolerLength: 1.29, coolerHeight: 0.29, coolerProjection: 0.68, payloadCapacityKg: undefined, doorWidth: 0.23, gap: 0,
      hasObstacle: false, obstacleMode: 'AUTO', obstacleWeight: 0, obstacleX: 5.23, obstacleY: 0.7, obstacleLength: 0.42, obstacleWidth: 0.54, unavailable: false, unavailableX: 2.5, unavailableY: 0, unavailableLength: 1.0, unavailableWidth: 2.05, axleCount: 2, axleMode: 'AUTO', axlePositions: [5.4, 4.2, 0, 0, 0, 0, 0, 0], axleCapacitiesKg: [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
      cargoGroups: [{ name: 'EUR паллета', length: 1.2, width: 0.8, height: 0, weight: 450, count: 10, rotatable: true, stackable: false }],
    },
  })
  const { fields, append, remove } = useFieldArray({ control, name: 'cargoGroups' })
  const currentPlan = useLoadPlanStore(s => s.plan)
  const [presetByGroup, setPresetByGroup] = useState<number[]>([0])

  // После ручного перетаскивания осей переносим их фактические координаты
  // обратно в форму, чтобы кнопка «Построить план» не возвращала AUTO-положение.
  useEffect(() => {
    if (!currentPlan || currentPlan.axles.length < 2) return
    if (!currentPlan.axles.some(axle => axle.source === 'FIXED')) return
    const ordered = currentPlan.axles.slice().sort((a, b) => b.position - a.position)
    setValue('axleMode', 'FIXED', { shouldValidate: true })
    ordered.forEach((axle, index) => {
      setValue(`axlePositions.${index}`, axle.position / 1000, { shouldValidate: false })
    })
  }, [currentPlan, setValue])
  const submit = (v: FormValues) => {
    const cargoGroups: CargoGroup[] = v.cargoGroups.map((group, index) => ({
      id: `cargo-${index + 1}`,
      name: group.name,
      length: group.length * 1000,
      width: group.width * 1000,
      height: group.height * 1000,
      weight: group.weight,
      count: group.count,
      rotatable: group.rotatable,
      stackable: false,
    }))

    const coolerLength = v.coolerLength * 1000
    const coolerHeight = v.coolerHeight * 1000
    const coolerProjection = v.coolerProjection * 1000
    const cooler: { x: number; y: number; length: number; width: number; height: number; blocksFloor: boolean; weight?: number } = {
      x: Math.max(0, v.vehicleLength * 1000 - coolerProjection),
      y: Math.max(0, (v.vehicleWidth * 1000 - coolerLength) / 2),
      length: coolerProjection,
      width: coolerLength,
      height: coolerHeight,
      blocksFloor: false,
    }
    const obstacleLength = v.obstacleLength * 1000
    const obstacleWidth = v.obstacleWidth * 1000
    // «Есть уже загруженный груз» по умолчанию считаем закреплённым
    // ближе к кабине. Новая загрузка выполняется со стороны задних дверей
    // и не требует переставлять уже загруженный груз.
    const autoObstacle = {
      x: Math.max(
        v.doorWidth * 1000 + v.gap * 1000,
        v.vehicleLength * 1000 - coolerProjection - obstacleLength
      ),
      y: Math.max(0, (v.vehicleWidth * 1000 - obstacleWidth) / 2),
      length: obstacleLength,
      width: obstacleWidth,
      weight: v.obstacleWeight ?? 0,
    }
    const customObstacle = {
      x: v.obstacleX * 1000,
      y: v.obstacleY * 1000,
      length: obstacleLength,
      width: obstacleWidth,
      weight: v.obstacleWeight ?? 0,
    }
    const customObstacles: Array<{ x: number; y: number; length: number; width: number; weight?: number; height?: number; blocksFloor?: boolean }> = v.hasObstacle && obstacleLength > 0 && obstacleWidth > 0
      ? [v.obstacleMode === 'FIXED' ? customObstacle : autoObstacle]
      : []
    const obstacles: Array<{ x: number; y: number; length: number; width: number; weight?: number; height?: number; blocksFloor?: boolean }> = [cooler, ...customObstacles]
    const unavailable = v.unavailable
      ? [{ x: v.unavailableX * 1000, y: v.unavailableY * 1000, length: v.unavailableLength * 1000, width: v.unavailableWidth * 1000 }]
      : []
    const gaps = v.gap ? [{ x: v.doorWidth * 1000, y: 0, length: v.gap * 1000, width: v.vehicleWidth * 1000 }] : []
    const blockedZones = [...obstacles.filter(o => o.blocksFloor !== false), ...unavailable, ...gaps]
    const overlaps = (a: { x: number; y: number; length: number; width: number }, b: { x: number; y: number; length: number; width: number }) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    const verticalZones = obstacles.filter(o => (o.height ?? 0) > 0)
    const hasVerticalClearance = (candidate: { x: number; y: number; length: number; width: number; height: number }) => {
      if (candidate.height <= 0) return true
      if (candidate.height > v.vehicleHeight * 1000) return false
      return !verticalZones.some(zone => {
        const overlapsFootprint =
          candidate.x < zone.x + zone.length &&
          candidate.x + candidate.length > zone.x &&
          candidate.y < zone.y + zone.width &&
          candidate.y + candidate.width > zone.y
        return overlapsFootprint && candidate.height > v.vehicleHeight * 1000 - (zone.height ?? 0)
      })
    }
    const canPlace = (x: number, y: number, length: number, width: number, height: number, placed: Array<{ x: number; y: number; length: number; width: number }>) => {
      const candidate = { x, y, length, width, height }
      if (x < 0 || y < 0 || x + length > v.vehicleLength * 1000 || y + width > v.vehicleWidth * 1000) return false
      if (!hasVerticalClearance(candidate)) return false
      if (blockedZones.some(o => overlaps(candidate, o))) return false
      return !placed.some(p => overlaps(candidate, p))
    }

    const items = cargoGroups.flatMap((group, groupIndex) =>
      Array.from({ length: group.count }, (_, itemIndex) => ({ group, groupIndex, itemIndex }))
    ).sort((a, b) => {
      const areaDiff = b.group.length * b.group.width - a.group.length * a.group.width
      if (areaDiff !== 0) return areaDiff
      return Math.max(b.group.length, b.group.width) - Math.max(a.group.length, a.group.width)
    })
    // Bottom-left / best-fit packing: generate meaningful corner candidates instead of
    // scanning the whole body on a coarse grid. Candidates are scored by compactness,
    // wall contact and adjacency, which helps mixed cargo fill irregular free space.
    const placements: Array<{ x: number; y: number; length: number; width: number; group: CargoGroup }> = []
    const blocked = blockedZones.map(z => ({ x: z.x, y: z.y, length: z.length, width: z.width }))
    const scoreCandidate = (x: number, y: number, length: number, width: number, placed: typeof placements, weight: number) => {
      const right = x + length
      const bottom = y + width
      // Не прижимаем груз автоматически к задним дверям: для осевой нагрузки
      // важнее продольный баланс всей массы. Поперечную укладку по стенкам
      // сохраняем — она уменьшает пустоты и делает план стабильнее.
      const wallContact = (y === 0 ? 1 : 0) + (bottom === v.vehicleWidth * 1000 ? 1 : 0)
      const adjacent = [...placed, ...blocked].reduce((score, p) => {
        const verticalTouch = (right === p.x || x === p.x + p.length) && y < p.y + p.width && bottom > p.y
        const horizontalTouch = (bottom === p.y || y === p.y + p.width) && x < p.x + p.length && right > p.x
        return score + (verticalTouch ? 2 : 0) + (horizontalTouch ? 2 : 0)
      }, 0)
      const axleCount = Math.max(2, v.axleCount)
      const assumedAxlePositions = Array.from({ length: axleCount }, (_, i) =>
        v.axleMode === 'FIXED'
          ? v.axlePositions[i] * 1000
          : v.vehicleLength * 1000 * (0.90 - 0.30 * i / Math.max(1, axleCount - 1))
      )
      const targetCenter = (assumedAxlePositions[0] + assumedAxlePositions[assumedAxlePositions.length - 1]) / 2
      const existingWeight = placed.reduce((sum, p) => sum + p.group.weight, 0)
      const existingMoment = placed.reduce((sum, p) => sum + p.group.weight * (p.x + p.length / 2), 0)
      const existingTransverseMoment = placed.reduce((sum, p) => sum + p.group.weight * (p.y + p.width / 2), 0)
      const candidateCenter = x + length / 2
      const candidateTransverseCenter = y + width / 2
      const loadCenter = (existingMoment + weight * candidateCenter) / Math.max(1, existingWeight + weight)
      const transverseCenter = (existingTransverseMoment + weight * candidateTransverseCenter) / Math.max(1, existingWeight + weight)
      const balancePenalty = Math.abs(loadCenter - targetCenter) * 10000
      const transversePenalty = Math.abs(transverseCenter - (v.vehicleWidth * 1000) / 2) * 180
      // Не складываем весь груз вдоль одной боковой стены. При наличии
      // свободного места алгоритм стремится распределять массу по обеим
      // сторонам кузова, одновременно сохраняя продольный баланс относительно осей.
      return wallContact * 700000 + adjacent * 12000 - balancePenalty - transversePenalty - x * 0.001
    }

    const candidatePoints = (length: number, width: number, placed: typeof placements) => {
      const xs = new Set<number>([0])
      const ys = new Set<number>([0])
      for (const p of [...placed, ...blocked]) {
        xs.add(p.x); xs.add(p.x + p.length)
        ys.add(p.y); ys.add(p.y + p.width)
      }
      const points: Array<{ x: number; y: number }> = []
      for (const y of ys) for (const x of xs) {
        if (x + length <= v.vehicleLength * 1000 && y + width <= v.vehicleWidth * 1000) points.push({ x, y })
      }
      return points
    }

    for (const item of items) {
      const orientations = item.group.rotatable && item.group.length !== item.group.width
        ? [[item.group.length, item.group.width], [item.group.width, item.group.length]]
        : [[item.group.length, item.group.width]]
      let best: { x: number; y: number; length: number; width: number; score: number } | undefined
      for (const [length, width] of orientations) {
        // Для стандартной EUR-паллеты при кузове шире 2,4 м
        // предпочитаем классическую транспортную раскладку:
        // короткая сторона 0,8 м вдоль X (длины кузова),
        // длинная сторона 1,2 м поперёк кузова.
        // Это даёт 2 паллеты в ряд при внутренней ширине 2,45 м.
        const shortSideAlongLength =
          item.group.length !== item.group.width &&
          length === Math.min(item.group.length, item.group.width) &&
          width === Math.max(item.group.length, item.group.width) &&
          width * 2 <= v.vehicleWidth * 1000
        const orientationBonus = shortSideAlongLength ? 500000000 : 0
        for (const point of candidatePoints(length, width, placements)) {
          if (!canPlace(point.x, point.y, length, width, item.group.height, placements)) continue
          const score = scoreCandidate(point.x, point.y, length, width, placements, item.group.weight) + orientationBonus
          if (!best || score > best.score) best = { ...point, length, width, score }
        }
      }
      if (best) placements.push({ x: best.x, y: best.y, length: best.length, width: best.width, group: item.group })
    }

    // Финальный safety-check: в итоговый план никогда не попадает груз,
    // пересекающий холодильную установку, препятствие, недоступную зону,
    // зазор или другой груз. Если свободного места нет — груз остаётся
    // неразмещённым и это отражается как N / requested.
    const safePlacements = placements.filter((p, index) => {
      const candidate = { x: p.x, y: p.y, length: p.length, width: p.width, height: p.group.height }
      const inside = candidate.x >= 0 && candidate.y >= 0 &&
        candidate.x + candidate.length <= v.vehicleLength * 1000 &&
        candidate.y + candidate.width <= v.vehicleWidth * 1000
      if (!inside || !hasVerticalClearance(candidate) || blockedZones.some(zone => overlaps(candidate, zone))) return false
      return !placements.some((other, otherIndex) =>
        otherIndex !== index &&
        overlaps(candidate, { x: other.x, y: other.y, length: other.length, width: other.width })
      )
    })

    const pallets = safePlacements.map((p, i) => ({
      id: i + 1,
      length: p.length,
      width: p.width,
      height: p.group.height,
      weight: p.group.weight,
      x: p.x,
      y: p.y,
      rotatable: p.group.rotatable,
      stackable: false,
    }))

    const plan: LoadPlan = {
      vehicleLength: v.vehicleLength * 1000,
      vehicleWidth: v.vehicleWidth * 1000,
      vehicleHeight: v.vehicleHeight * 1000,
      payloadCapacityKg: v.payloadCapacityKg,
      doors: [{ id: 'rear', x: 0, y: 0, length: v.doorWidth * 1000, width: v.vehicleWidth * 1000, label: 'Двери' }],
      gaps: v.gap ? [{ id: 'gap', x: v.doorWidth * 1000, y: 0, length: v.gap * 1000, width: v.vehicleWidth * 1000, label: 'Зазор' }] : [],
      obstacles: [{ id: 'cooler', ...cooler, label: 'Холодильная установка' }, ...customObstacles.map((o, index) => ({ id: `obstacle-${index + 1}`, ...o, label: v.obstacleMode === 'FIXED' ? 'Уже загружено · фиксированное' : 'Уже загружено · у кабины' }))],
      unavailableZones: v.unavailable ? [{ id: 'unavailable', x: v.unavailableX * 1000, y: v.unavailableY * 1000, length: v.unavailableLength * 1000, width: v.unavailableWidth * 1000, label: 'Недоступная зона' }] : [],
      // Если пользователь не указал оси, используем минимальную базовую конфигурацию
      // для грузового кузова — 2 оси. Это только геометрическая модель:
      // фактическая нагрузка на оси на этапе 1 всё равно не проверяется.
      axles: Array.from({ length: Math.max(2, v.axleCount) }, (_, i) => ({
        id: `axle-${i + 1}`,
        position: v.axleMode === 'FIXED'
          ? v.axlePositions[i] * 1000
          : v.vehicleLength * 1000 * (
              0.90 - 0.30 * i / Math.max(1, Math.max(2, v.axleCount) - 1)
            ),
        capacityKg: v.axleCapacitiesKg[i] ?? 0,
        source: v.axleMode,
      })),
      cargoGroups,
      pallets,
    }
    void (async () => {
      const variants = await PlacementService.createVariants(plan)
      await setPlanVariants(variants)
    })()
  }
  const recognitionRef = useRef<any>(null)
  const speak = () => {
    if (!SpeechService.isSupported()) {
      setRecognized('Голосовой ввод не поддерживается этим браузером. Откройте Chrome или Edge и разрешите доступ к микрофону.')
      return
    }
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'ru-RU'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onresult = (event: any) => {
      const text = Array.from(event.results).map((r: any) => r[0]?.transcript ?? '').join(' ')
      setRecognized(text)
    }
    recognition.onerror = (event: any) => {
      setListening(false)
      setRecognized(event.error === 'not-allowed' ? 'Нет доступа к микрофону. Разрешите микрофон для localhost.' : 'Не удалось распознать речь. Попробуйте ещё раз.')
    }
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    setRecognized('')
    setListening(true)
    try {
      recognition.start()
    } catch (error: any) {
      setListening(false)
      setRecognized(error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
        ? 'Браузер не разрешил микрофон. Откройте приложение в Chrome/Edge и разрешите микрофон для localhost.'
        : 'Не удалось запустить микрофон. Попробуйте ещё раз.')
    }
  }
  const cancelSpeech = () => {
    recognitionRef.current?.abort()
    recognitionRef.current = null
    setListening(false)
  }
  const applyPreset = (groupIndex: number, presetIndex: number) => {
    setPresetByGroup(current => current.map((value, index) => index === groupIndex ? presetIndex : value))
    if (presets[presetIndex][1]) {
      setValue(`cargoGroups.${groupIndex}.length`, presets[presetIndex][1])
      setValue(`cargoGroups.${groupIndex}.width`, presets[presetIndex][2])
    }
  }
  const addCargoGroup = () => {
    append({ name: `Грузовая группа ${fields.length + 1}`, length: 1.2, width: 0.8, height: 0, weight: 450, count: 1, rotatable: true, stackable: false })
    setPresetByGroup(current => [...current, 0])
  }
  const removeCargoGroup = (groupIndex: number) => {
    if (fields.length <= 1) return
    remove(groupIndex)
    setPresetByGroup(current => current.filter((_, index) => index !== groupIndex))
  }
  return <form onSubmit={handleSubmit(submit)} className="plan-form">
    <div className="section-label">Кузов, двери и зазоры</div>
    <div className="field-grid three"><Field label="Длина, м" input={<input inputMode="decimal" placeholder="6,0" {...register('vehicleLength')} />} error={errors.vehicleLength?.message} /><Field label="Ширина, м" input={<input inputMode="decimal" placeholder="2,05" {...register('vehicleWidth')} />} error={errors.vehicleWidth?.message} /><Field label="Высота, м" input={<input inputMode="decimal" placeholder="2,2" {...register('vehicleHeight')} />} error={errors.vehicleHeight?.message} /></div>
    <div className="section-label cargo-label">Холодильная установка · по центру передней стенки</div>
    <div className="field-grid three"><Field label="Длина, м" input={<input inputMode="decimal" placeholder="1,23" {...register('coolerLength')} />} error={errors.coolerLength?.message} /><Field label="Высота, м" input={<input inputMode="decimal" placeholder="0,29" {...register('coolerHeight')} />} error={errors.coolerHeight?.message} /><Field label="Выпирает, м" input={<input inputMode="decimal" placeholder="0,68" {...register('coolerProjection')} />} error={errors.coolerProjection?.message} /></div><small className="field-hint">Под холодильной установкой полезная высота = высота кузова − высота установки. Например: 2,30 − 0,29 = 2,01 м на участке длиной 1,29 м.</small>
    <div className="field-grid three"><Field label="Двери, м" input={<input inputMode="decimal" placeholder="0,23" {...register('doorWidth')} />} error={errors.doorWidth?.message} /><Field label="Зазор, м" input={<input inputMode="decimal" placeholder="0" {...register('gap')} />} error={errors.gap?.message} /><Field label="Грузоподъёмность, кг" input={<input {...register('payloadCapacityKg')} placeholder="не указана" />} error={errors.payloadCapacityKg?.message} /></div>
    <div className="section-label cargo-label">Уже загруженный груз и недоступные зоны</div>
    <label className="check-field"><input type="checkbox" {...register('hasObstacle')} /> Уже есть загруженный груз</label>
    {watch('hasObstacle') && <>
      <small className="field-hint">Этот груз уже стоит в кузове и не перемещается. По умолчанию он находится ближе к кабине, а новый груз загружается от задних дверей.</small>
      <div className="field-grid two obstacle-mode-row"><Field label="Положение" input={<select {...register('obstacleMode')}><option value="AUTO">У кабины — автоматически</option><option value="FIXED">Задать положение вручную</option></select>} error={errors.obstacleMode?.message} /><Field label="Вес уже загруженного, кг" input={<input inputMode="decimal" {...register('obstacleWeight')} placeholder="не указан" />} error={errors.obstacleWeight?.message} /></div>
      <div className="field-grid four"><Field label="Габарит X, м" input={<input inputMode="decimal" {...register('obstacleLength')} />} error={errors.obstacleLength?.message} /><Field label="Габарит Y, м" input={<input inputMode="decimal" {...register('obstacleWidth')} />} error={errors.obstacleWidth?.message} />{watch('obstacleMode') === 'FIXED' && <><Field label="Положение X, м" input={<input inputMode="decimal" {...register('obstacleX')} />} error={errors.obstacleX?.message} /><Field label="Положение Y, м" input={<input inputMode="decimal" {...register('obstacleY')} />} error={errors.obstacleY?.message} /></>}</div>
    </>}
    <label className="check-field"><input type="checkbox" {...register('unavailable')} /> Есть недоступная зона</label>
    <div className="field-grid four"><Field label="X, м" input={<input inputMode="decimal" {...register('unavailableX')} />} error={errors.unavailableX?.message} /><Field label="Y, м" input={<input inputMode="decimal" {...register('unavailableY')} />} error={errors.unavailableY?.message} /><Field label="Длина, м" input={<input inputMode="decimal" {...register('unavailableLength')} />} error={errors.unavailableLength?.message} /><Field label="Ширина, м" input={<input inputMode="decimal" {...register('unavailableWidth')} />} error={errors.unavailableWidth?.message} /></div>
    <div className="section-label cargo-label">Автомобиль и оси</div>
    <div className="axle-control-card">
      <div className="axle-control-head">
        <strong>Положение осей</strong>
        <span>От задней стенки кузова</span>
      </div>
      <div className="axle-mode-switch" role="group" aria-label="Режим задания осей">
        <button type="button" className={watch('axleMode') === 'AUTO' ? 'active' : ''} onClick={() => setValue('axleMode', 'AUTO', { shouldValidate: true })}>
          Автоматически
          <small>ориентировочно</small>
        </button>
        <button type="button" className={watch('axleMode') === 'FIXED' ? 'active' : ''} onClick={() => setValue('axleMode', 'FIXED', { shouldValidate: true })}>
          Задать вручную
          <small>точные координаты</small>
        </button>
      </div>
      <div className="field-grid two axle-mode-grid">
        <Field label="Количество осей" input={<input {...register('axleCount')} placeholder="2" />} error={errors.axleCount?.message} />
        <div className="axle-current-mode"><span>Режим</span><b>{watch('axleMode') === 'FIXED' ? 'Ручной ввод' : 'Автоматическая модель'}</b></div>
      </div>
      <div className="axle-capacity-block">
        <small className="field-hint">Допустимая нагрузка используется только для проверки. Оставьте поле пустым, если данных нет.</small>
        <div className="field-grid four">
          {Array.from({ length: Math.max(2, Number(watch('axleCount')) || 2) }, (_, index) =>
            <Field key={index} label={'Ось ' + (index + 1) + ' · допуск, кг'} input={<input inputMode="decimal" placeholder="не указано" {...register((`axleCapacitiesKg.${index}`) as const)} />} error={errors.axleCapacitiesKg?.[index]?.message} />
          )}
        </div>
      </div>
      {watch('axleMode') === 'FIXED' && <div className="axle-position-block">
        <small className="field-hint">Укажите расстояние от задней стенки кузова до центра каждой оси. В нашей схеме Ось 1 — передняя (рулевая), Ось 2 — задняя (ведущая). Текущий статический расчёт учитывает массу груза и закреплённого груза, но пока не включает снаряжённую массу самого автомобиля.</small>
        <div className="field-grid four">
          {Array.from({ length: Math.max(2, Number(watch('axleCount')) || 2) }, (_, index) =>
            <Field key={index} label={`Ось ${index + 1} · ${index === 0 ? 'передняя' : index === 1 && Math.max(2, Number(watch('axleCount')) || 2) === 2 ? 'задняя' : 'следующая'}, м от задней стенки`} input={<input inputMode="decimal" {...register(`axlePositions.${index}` as const)} />} error={errors.axlePositions?.[index]?.message} />
          )}
        </div>
      </div>}
      {watch('axleMode') === 'AUTO' && <small className="field-hint">Положение осей не известно. Используется ориентировочная модель для визуальной оценки центра массы. На схеме оси можно сразу перетащить мышью или пальцем — после перемещения их положения станут ручными.</small>}
    </div>
    <div className="section-label cargo-label">Грузовые группы</div>
    <div className="cargo-groups">
      {fields.map((field, index) => (
        <section className="cargo-group-card" key={field.id}>
          <div className="cargo-group-head">
            <strong>Группа {index + 1}</strong>
            {fields.length > 1 && <button type="button" className="remove-group" onClick={() => removeCargoGroup(index)}>Удалить</button>}
          </div>
          <Field label="Название" input={<input {...register(`cargoGroups.${index}.name`)} placeholder={`Грузовая группа ${index + 1}`} />} error={errors.cargoGroups?.[index]?.name?.message} />
          <div className="preset-row">
            {presets.map((p, presetIndex) => (
              <button type="button" key={p[0]} className={presetByGroup[index] === presetIndex ? 'preset active' : 'preset'} onClick={() => applyPreset(index, presetIndex)}>{p[0]}</button>
            ))}
          </div>
          <div className="field-grid four">
            <Field label="Длина, м" input={<input inputMode="decimal" placeholder="1,2" {...register(`cargoGroups.${index}.length`)} />} error={errors.cargoGroups?.[index]?.length?.message} />
            <Field label="Ширина, м" input={<input inputMode="decimal" placeholder="0,8" {...register(`cargoGroups.${index}.width`)} />} error={errors.cargoGroups?.[index]?.width?.message} />
            <Field label="Высота, м" input={<input inputMode="decimal" placeholder="0" {...register(`cargoGroups.${index}.height`)} />} error={errors.cargoGroups?.[index]?.height?.message} />
            <Field label="Вес, кг" input={<input inputMode="decimal" {...register(`cargoGroups.${index}.weight`)} />} error={errors.cargoGroups?.[index]?.weight?.message} />
          </div>
          <div className="field-grid two">
            <Field label="Количество" input={<input {...register(`cargoGroups.${index}.count`)} />} error={errors.cargoGroups?.[index]?.count?.message} />
            <div className="group-options">
              <label className="check-field inline"><input type="checkbox" {...register(`cargoGroups.${index}.rotatable`)} /> Можно поворачивать</label>
              <label className="check-field inline muted-option"><input type="checkbox" disabled checked readOnly /> Ставить в штабель (скоро)</label>
            </div>
          </div>
        </section>
      ))}
    </div>
    <button type="button" className="add-group-button" onClick={addCargoGroup}>+ Добавить грузовую группу</button>
    {recognized && <div className="recognized">Распознано: <b>{recognized}</b><button type="button" onClick={() => setRecognized('')}>×</button></div>}
    <button type="submit" className="primary-button">Построить план <span>→</span></button>
    <div className="voice-actions">
      <button type="button" onClick={speak} disabled={listening} className="voice-button">{listening ? '● Слушаю…' : '⌁ Описать голосом'}</button>
      {listening && <button type="button" onClick={cancelSpeech} className="voice-cancel">Отмена</button>}
    </div>
  </form>
}

function Assistant() {
  const loadDemo = useLoadPlanStore(s => s.loadDemo), loading = useLoadPlanStore(s => s.isLoading), error = useLoadPlanStore(s => s.error)
  return <aside className="assistant-panel"><div className="brand"><span className="brand-mark">✦</span><span>AI LOAD PLANNER</span></div><div className="assistant-copy"><span className="eyebrow">ПЕРВЫЙ ЗАПУСК</span><h1>Расскажите, какая у вас машина и какой груз.</h1><p>Сначала покажем схему размещения. Непроверенные параметры явно отмечены.</p></div><button onClick={() => void loadDemo()} disabled={loading} className="demo-button"><span className="play">▶</span>{loading ? 'Загружаем…' : 'Попробовать пример'}</button><div className="or"><span />или<span /></div><div className="manual-hint">Ввести вручную</div><PlanForm />{error && <div className="error-box">{error}</div>}<footer>Этап 1 · frontend · mock AI / speech / solver</footer></aside>
}

function DimLine({ x1, y1, x2, y2, label, offset = 0 }: { x1: number; y1: number; x2: number; y2: number; label: string; offset?: number }) {
  const horizontal = Math.abs(y2 - y1) < Math.abs(x2 - x1)
  const tx = horizontal ? (x1 + x2) / 2 : x1 + offset
  const ty = horizontal ? y1 + offset : (y1 + y2) / 2
  return <g className="dim-line"><line x1={x1} y1={y1} x2={x2} y2={y2} /><text x={tx} y={ty} textAnchor="middle">{label}</text></g>
}

function Visualizer() {
  const {
    plan, variants, selectedVariant, calculations, selectedPallet, setSelectedPallet,
    setSelectedVariant, rotateSelectedPallet, movePallet, undoLastMove, suggestVariant,
    setSelectedPalletWeight, rotationFeedback, history, moveAxlePosition,
  } = useLoadPlanStore()
  const [zoom, setZoom] = useState(1)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [drag, setDrag] = useState<{
    id: number
    offsetX: number
    offsetY: number
    originalX: number
    originalY: number
    x: number
    y: number
    valid: boolean
  } | null>(null)
  const [axleDrag, setAxleDrag] = useState<{ id: string; originalX: number; x: number } | null>(null)
  const [vehicleFitSuggestion, setVehicleFitSuggestion] = useState<ReturnType<typeof findMinimumVehicleSize> | null>(null)
  const [weightDraft, setWeightDraft] = useState('')
  useEffect(() => {
    if (!axleDrag || !plan) return
    const handleMove = (event: globalThis.PointerEvent) => {
      const svg = svgRef.current
      const matrix = svg?.getScreenCTM()
      if (!svg || !matrix) return
      const point = svg.createSVGPoint()
      point.x = event.clientX
      point.y = 0
      const svgPoint = point.matrixTransform(matrix.inverse())
      const axles = plan.axles.slice().sort((a, b) => a.position - b.position)
      const currentIndex = axles.findIndex(axle => axle.id === axleDrag.id)
      if (currentIndex < 0) return
      const minGap = 500
      const minX = currentIndex > 0 ? axles[currentIndex - 1].position + minGap : 0
      const maxX = currentIndex < axles.length - 1 ? axles[currentIndex + 1].position - minGap : plan.vehicleLength
      const x = Math.max(minX, Math.min(maxX, Math.round(svgPoint.x / 50) * 50))
      event.preventDefault()
      setAxleDrag(current => current && current.id === axleDrag.id ? { ...current, x } : current)
    }
    const handleUp = async (event: globalThis.PointerEvent) => {
      const current = axleDrag
      if (!current) return
      event.preventDefault()
      // На отпускании сохраняем последнее положение, которое уже было
      // показано во время pointermove. Повторный пересчёт по координате pointerup
      // мог вернуть ось назад при резком отпускании/потере последнего move-события.
      const x = current.x
      if (event.type !== 'pointercancel' && Math.abs(x - current.originalX) >= 50) {
        await moveAxlePosition(current.id, x)
      }
      setAxleDrag(null)
    }
    window.addEventListener('pointermove', handleMove, { passive: false })
    window.addEventListener('pointerup', handleUp, { passive: false })
    window.addEventListener('pointercancel', handleUp, { passive: false })
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [axleDrag, plan, moveAxlePosition])

  useEffect(() => {
    let active = true
    if (!plan) {
      setVehicleFitSuggestion(null)
      return
    }
    const placement = calculations.find(item => item.id === 'count')
    const match = placement?.value.match(/^(\d+) \/ (\d+)$/)
    const placed = match ? Number(match[1]) : plan.pallets.length
    const requested = match ? Number(match[2]) : plan.cargoGroups.reduce((sum, group) => sum + group.count, 0)

    if (placed >= requested) {
      setVehicleFitSuggestion(null)
      return
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const suggestion = await findMinimumVehicleSize(plan)
        if (active) setVehicleFitSuggestion(suggestion)
      })()
    }, 40)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [plan, calculations])

  useEffect(() => {
    if (!selectedPallet) {
      setWeightDraft('')
      return
    }
    const current = plan?.pallets.find(p => p.id === selectedPallet)
    setWeightDraft(current ? String(current.weight) : '')
  }, [selectedPallet, plan?.pallets.find(p => p.id === selectedPallet)?.weight])

  if (!plan) return <main className="visualizer empty"><div className="empty-art">▱ ▱</div><h2>Схема загрузки появится здесь</h2><p>Нажмите «Попробовать пример» или заполните параметры вручную.</p></main>
  const overlapsRect = (a: { x: number; y: number; length: number; width: number }, b: { x: number; y: number; length: number; width: number }) =>
    a.x < b.x + b.length && a.x + a.length > b.x &&
    a.y < b.y + b.width && a.y + a.width > b.y

  const snapPosition = (value: number, size: number, axis: "x" | "y", id: number) => {
    const max = axis === "x" ? plan.vehicleLength - size : plan.vehicleWidth - size
    const snapped = Math.max(0, Math.min(max, Math.round(value / 50) * 50))
    const candidates = [0, max]
    for (const other of plan.pallets) {
      if (other.id === id) continue
      if (axis === "x") candidates.push(other.x, other.x + other.length - size)
      else candidates.push(other.y, other.y + other.width - size)
    }
    const near = candidates.find(candidate => Math.abs(candidate - snapped) <= 70)
    return near == null ? snapped : Math.max(0, Math.min(max, near))
  }

  const isValidDrop = (id: number, x: number, y: number) => {
    const pallet = plan.pallets.find(p => p.id === id)
    if (!pallet) return false
    const candidate = { ...pallet, x, y }
    const blocked = [...plan.obstacles.filter(o => o.blocksFloor !== false), ...plan.unavailableZones, ...plan.gaps]
    const verticalZones = plan.obstacles.filter(o => (o.height ?? 0) > 0)
    const verticalClear = candidate.height <= 0 || (
      candidate.height <= plan.vehicleHeight &&
      !verticalZones.some(zone =>
        candidate.height > plan.vehicleHeight - (zone.height ?? 0) &&
        overlapsRect(candidate, zone)
      )
    )
    return candidate.x >= 0 && candidate.y >= 0 &&
      candidate.x + candidate.length <= plan.vehicleLength &&
      candidate.y + candidate.width <= plan.vehicleWidth &&
      verticalClear &&
      !blocked.some(zone => overlapsRect(candidate, zone)) &&
      plan.pallets.filter(p => p.id !== id).every(other => !overlapsRect(candidate, other))
  }

  const clientToSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    return point.matrixTransform(matrix.inverse())
  }

  const pointerToSvg = (event: ReactPointerEvent<SVGGElement>) =>
    clientToSvg(event.clientX, event.clientY)

  const beginAxleDrag = (event: ReactPointerEvent<SVGGElement>, axleId: string, currentX: number) => {
    if (plan.axles.length < 2 || axleDrag) return
    const point = pointerToSvg(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    setAxleDrag({ id: axleId, originalX: currentX, x: currentX })
  }

  const beginDrag = (event: ReactPointerEvent<SVGGElement>, palletId: number) => {
    if (event.button !== 0 && event.pointerType !== "touch") return
    const pallet = plan.pallets.find(p => p.id === palletId)
    const point = pointerToSvg(event)
    if (!pallet || !point) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedPallet(palletId)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    setDrag({
      id: palletId,
      offsetX: point.x - pallet.x,
      offsetY: point.y - pallet.y,
      originalX: pallet.x,
      originalY: pallet.y,
      x: pallet.x,
      y: pallet.y,
      valid: true,
    })
  }

  const updateDrag = (event: ReactPointerEvent<SVGGElement>, palletId: number) => {
    if (!drag || drag.id !== palletId) return
    const point = pointerToSvg(event)
    const pallet = plan.pallets.find(p => p.id === palletId)
    if (!point || !pallet) return
    const x = snapPosition(point.x - drag.offsetX, pallet.length, "x", palletId)
    const y = snapPosition(point.y - drag.offsetY, pallet.width, "y", palletId)
    setDrag({ ...drag, x, y, valid: isValidDrop(palletId, x, y) })
  }

  const finishDrag = async (event: ReactPointerEvent<SVGGElement>, palletId: number) => {
    if (!drag || drag.id !== palletId) return
    event.preventDefault()
    event.stopPropagation()
    const current = drag
    setDrag(null)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    if (current.x !== current.originalX || current.y !== current.originalY) {
      await movePallet(palletId, current.x, current.y)
    }
  }

  const cancelDrag = (event: ReactPointerEvent<SVGGElement>) => {
    if (!drag) return
    event.preventDefault()
    setDrag(null)
  }

  const visualPlan = {
    ...plan,
    pallets: drag ? plan.pallets.map(p => p.id === drag.id ? { ...p, x: drag.x, y: drag.y } : p) : plan.pallets,
    axles: axleDrag ? plan.axles.map(axle => axle.id === axleDrag.id ? { ...axle, position: axleDrag.x, source: 'FIXED' as const } : axle) : plan.axles,
  }
  const selected = visualPlan.pallets.find(p => p.id === selectedPallet)
  const orientation = selected ? (selected.length >= selected.width ? 'По длине кузова' : 'Повернута на 90°') : '—'
  const conflicts = visualPlan.pallets.filter((p, i) => {
    const intersects = (a: typeof p, b: typeof p) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    return p.x < 0 || p.y < 0 || p.x + p.length > plan.vehicleLength || p.y + p.width > plan.vehicleWidth ||
      p.height > plan.vehicleHeight ||
      plan.obstacles.some(o => (o.height ?? 0) > 0 && p.height > plan.vehicleHeight - (o.height ?? 0) &&
        p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.obstacles.filter(o => o.blocksFloor !== false).some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.unavailableZones.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.gaps.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      visualPlan.pallets.slice(i + 1).some(q => intersects(p, q))
  })
  const conflictReason = selected && conflicts.some(p => p.id === selected.id)
    ? (selected.x + selected.length > plan.vehicleLength || selected.y + selected.width > plan.vehicleWidth || selected.height > plan.vehicleHeight ? 'Не помещается по габаритам/высоте'
      : plan.obstacles.some(o => (o.height ?? 0) > 0 && selected.height > plan.vehicleHeight - (o.height ?? 0) &&
          selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Не проходит по высоте под препятствием'
      : plan.obstacles.filter(o => o.blocksFloor !== false).some(o => selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Пересекает препятствие'
      : plan.unavailableZones.some(o => selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Попадает в недоступную зону'
      : plan.gaps.some(o => selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Попадает в зону зазора'
      : 'Пересекает другую паллету')
    : ''

  const placementCheck = calculations.find(c => c.id === 'count')
  const placementParts = placementCheck?.value.match(/^(\d+) \/ (\d+)$/)
  const placedCount = placementParts ? Number(placementParts[1]) : plan.pallets.length
  const requestedCount = placementParts ? Number(placementParts[2]) : plan.pallets.length
  const unplacedCount = Math.max(0, requestedCount - placedCount)
  const variantLabels = ['Сбалансированный', 'Вдоль длинной стороны', 'По осям']
  const variantMeta = variants.map((variant, index) => {
    const cg = getLoadGeometry(variant)
    const requested = variant.cargoGroups.reduce((sum, g) => sum + g.count, 0)
    const placed = variant.pallets.length
    const cgInsideAxles = cg.cgX >= cg.axlePositions[0] && cg.cgX <= cg.axlePositions[cg.axlePositions.length - 1]
    const axleText = cgInsideAxles ? 'оси: в базе' : 'оси: вне базы'
    return { index, placed, requested, cg, axleText }
  })
  return <main className="visualizer"><header className="visual-header"><div><span className="eyebrow">ПЛАН ЗАГРУЗКИ</span><h2>Кузов · {plan.vehicleLength} × {plan.vehicleWidth} × {plan.vehicleHeight} мм</h2></div><div className="header-stat"><b>{plan.pallets.length}/{plan.cargoGroups.reduce((sum, g) => sum + g.count, 0)}</b><span>паллет</span></div></header><section className="canvas-wrap"><div className="map-toolbar">
  <span>{drag ? (drag.valid ? 'МОЖНО ПОСТАВИТЬ' : 'НЕЛЬЗЯ ПОСТАВИТЬ') : axleDrag ? 'ПЕРЕМЕЩЕНИЕ ОСИ · ОТПУСТИТЕ ДЛЯ ФИКСАЦИИ' : 'ПЕРЕТАЩИТЕ ПАЛЛЕТУ ИЛИ ОСЬ МЫШЬЮ / ПАЛЬЦЕМ'}</span>
  <div className="map-actions">
    <button type="button" onClick={() => void undoLastMove()} disabled={history.length === 0}>↶ Отменить</button>
    <button type="button" onClick={() => void suggestVariant()} disabled={variants.length < 2}>💡 Предложить вариант</button>
    <button type="button" onClick={() => setZoom(z => Math.max(.75, Number((z - .25).toFixed(2))))} aria-label="Уменьшить">−</button>
    <button type="button" onClick={() => setZoom(1)} aria-label="Сбросить масштаб">100%</button>
    <button type="button" onClick={() => setZoom(z => Math.min(2.5, Number((z + .25).toFixed(2))))} aria-label="Увеличить">+</button>
  </div>
</div><div className="variant-picker"><span>ВАРИАНТЫ РАЗМЕЩЕНИЯ</span><div className="variant-buttons">{variantMeta.map(meta => <button key={meta.index} type="button" className={selectedVariant === meta.index ? "active" : ""} onClick={() => void setSelectedVariant(meta.index)} disabled={!variants[meta.index]}><strong>{meta.index + 1}. {variantLabels[meta.index]}</strong><small>{meta.placed} / {meta.requested} · {meta.axleText}</small></button>)}</div><small>Каждый вариант рассчитывается для фактического количества груза. Сравните схему, центр массы и нагрузку на оси.</small></div><div className="svg-viewport"><svg ref={svgRef} viewBox={`-500 -280 ${plan.vehicleLength + 1000} ${plan.vehicleWidth + 750}`} style={{ transform: `scale(${zoom})` }} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Вид сверху на кузов с паллетами" className="truck-svg"><defs><pattern id="grid" width="500" height="500" patternUnits="userSpaceOnUse"><path d="M 500 0 L 0 0 0 500" fill="none" stroke="#dbe5ea" strokeWidth="8" /></pattern><pattern id="gridSmall" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#edf2f3" strokeWidth="3" /></pattern><marker id="axisArrow" markerWidth="14" markerHeight="14" refX="10" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z" className="axis-arrow" /></marker><marker id="cgChangeArrow" markerWidth="18" markerHeight="18" refX="14" refY="6" orient="auto"><path d="M0 0L14 6L0 12Z" className="cg-change-arrow" /></marker></defs><text x={plan.vehicleLength / 2} y="-135" textAnchor="middle" className="dimension">{plan.vehicleLength.toLocaleString('ru-RU')} мм</text><path d={`M0 -80h${plan.vehicleLength}`} className="dimension-line" /><text x="-330" y={plan.vehicleWidth / 2} textAnchor="middle" transform={`rotate(-90 -330 ${plan.vehicleWidth / 2})`} className="dimension">{plan.vehicleWidth.toLocaleString('ru-RU')} мм</text><rect x="0" y="0" width={plan.vehicleLength} height={plan.vehicleWidth} rx="28" fill="url(#gridSmall)" className="truck-body" /><rect x="0" y="0" width={plan.vehicleLength} height={plan.vehicleWidth} fill="url(#grid)" className="truck-grid-major" pointerEvents="none" /><g className="meter-scale" pointerEvents="none">{Array.from({ length: Math.floor(plan.vehicleLength / 1000) + 1 }, (_, i) => <g key={i}><line x1={i * 1000} y1={plan.vehicleWidth + 35} x2={i * 1000} y2={plan.vehicleWidth + 95} /><text x={i * 1000} y={plan.vehicleWidth + 125} textAnchor="middle">{i} м</text></g>)}</g><rect x="0" y="0" width={plan.doors[0]?.length ?? 0} height={plan.vehicleWidth} fill="#d9e4e8" opacity=".7" /><path d={`M0 0H${plan.doors[0]?.length ?? 0} M0 ${plan.vehicleWidth}H${plan.doors[0]?.length ?? 0}`} className="door-opening" /><path d={`M0 0L${Math.max(80, (plan.doors[0]?.length ?? 0) * .8)} ${plan.vehicleWidth / 2}L0 ${plan.vehicleWidth}`} className="door-leaf" />{plan.gaps.map(g => <g key={g.id}><rect x={g.x} y={g.y} width={g.length} height={g.width} className="gap-zone" /><text x={g.x + g.length / 2} y={g.width / 2} textAnchor="middle" className="gap-label">ЗАЗОР</text></g>)}<path d={`M0 150h140 M0 ${Math.max(150, plan.vehicleWidth - 150)}h140`} className="door" /><text x={(plan.doors[0]?.length ?? 0) / 2} y={plan.vehicleWidth / 2} textAnchor="middle" transform={`rotate(-90 ${(plan.doors[0]?.length ?? 0) / 2} ${plan.vehicleWidth / 2})`} className="door-label">ДВЕРИ</text>{plan.obstacles.filter(o => o.id !== 'cooler').map(o => <g key={o.id}><rect x={o.x} y={o.y} width={o.length} height={o.width} rx="24" className="obstacle" /><text x={o.x + o.length / 2} y={o.y + o.width / 2} textAnchor="middle" className="obstacle-label">{o.label}</text>{(o.height ?? 0) > 0 && <><rect x={o.x} y={o.y} width={o.length} height={o.width} rx="24" className="ceiling-clearance-zone" pointerEvents="none" /><text x={o.x + o.length / 2} y={o.y + o.width + 150} textAnchor="middle" className="ceiling-clearance-label" pointerEvents="none">↓ полезная высота {((plan.vehicleHeight - (o.height ?? 0)) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м</text></>}</g>)}{plan.unavailableZones.map(o => <g key={o.id}><rect x={o.x} y={o.y} width={o.length} height={o.width} rx="16" className="unavailable-zone" /><text x={o.x + o.length / 2} y={o.y + o.width / 2} textAnchor="middle" className="obstacle-label">{o.label}</text></g>)}{visualPlan.pallets.map(p => <g
  key={p.id}
  onClick={() => !drag && setSelectedPallet(p.id)}
  onPointerDown={e => beginDrag(e, p.id)}
  onPointerMove={e => updateDrag(e, p.id)}
  onPointerUp={e => void finishDrag(e, p.id)}
  onPointerCancel={cancelDrag}
  className={`pallet-group ${drag?.id === p.id ? 'pallet-dragging' : ''}`}
><rect x={p.x} y={p.y} width={p.length} height={p.width} rx="18" className={`pallet ${selectedPallet === p.id ? 'selected' : ''} ${conflicts.some(c => c.id === p.id) ? 'pallet-conflict' : ''} ${drag?.id === p.id ? (drag.valid ? 'drag-valid' : 'drag-invalid') : ''}`} /><text x={p.x + p.length / 2} y={p.y + p.width / 2 - 12} textAnchor="middle" className="pallet-number">{p.id}</text><text x={p.x + p.length / 2} y={p.y + p.width / 2 + 62} textAnchor="middle" className="pallet-size">X {((p.length) / 1000).toLocaleString('ru-RU')} м · Y {((p.width) / 1000).toLocaleString('ru-RU')} м</text>{selectedPallet === p.id && <><g className="pallet-rotate-control" onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void rotateSelectedPallet() }} pointerEvents={p.rotatable && p.length !== p.width ? 'all' : 'none'}><circle cx={p.x + p.length / 2} cy={p.y - 125} r="52" /><text x={p.x + p.length / 2} y={p.y - 107} textAnchor="middle">↻</text></g><DimLine x1={p.x} y1={p.y - 70} x2={p.x + p.length} y2={p.y - 70} label={`${(p.length / 1000).toLocaleString('ru-RU')} м`} offset={-18} /><DimLine x1={p.x - 70} y1={p.y} x2={p.x - 70} y2={p.y + p.width} label={`${(p.width / 1000).toLocaleString('ru-RU')} м`} offset={-18} /><text x={p.x + p.length / 2} y={p.y + p.width + 115} textAnchor="middle" className="coord-label">X {(p.x / 1000).toLocaleString('ru-RU')} м · Y {(p.y / 1000).toLocaleString('ru-RU')} м</text></>}</g>)}{(() => {
  const cooler = plan.obstacles.find(o => o.id === 'cooler')
  if (!cooler) return null
  return <g className="fixed-cooler" pointerEvents="none">
    <rect x={cooler.x} y={cooler.y} width={cooler.length} height={cooler.width} rx="28" className="cooler-fixed-body" />
    <rect x={cooler.x + 55} y={cooler.y + 55} width={Math.max(80, cooler.length - 110)} height={Math.max(80, cooler.width - 110)} rx="18" className="cooler-fixed-inner" />
    <line x1={cooler.x + 90} y1={cooler.y + cooler.width / 2} x2={cooler.x + cooler.length - 90} y2={cooler.y + cooler.width / 2} className="cooler-fixed-grille" />
    <text x={cooler.x + cooler.length / 2} y={cooler.y + cooler.width / 2 + 34} textAnchor="middle" className="cooler-fixed-label">ХОЛОДИЛЬНИК</text>
    <text x={cooler.x + cooler.length / 2} y={cooler.y + cooler.width + 115} textAnchor="middle" className="cooler-fixed-note">СТАЦИОНАРНО · ПО ЦЕНТРУ ПЕРЕДНЕЙ СТЕНКИ</text>
    {(cooler.height ?? 0) > 0 && <><rect x={cooler.x} y={cooler.y} width={cooler.length} height={cooler.width} rx="28" className="ceiling-clearance-zone" /><text x={cooler.x + cooler.length / 2} y={cooler.y + cooler.width + 160} textAnchor="middle" className="ceiling-clearance-label">↓ полезная высота {((plan.vehicleHeight - (cooler.height ?? 0)) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м</text></>}
  </g>
})()}{(() => {
  const loadGeometry = getLoadGeometry(visualPlan)
  return <g className="load-axles">
    {loadGeometry.axlePositions.map((x, i) => {
      const sortedAxles = plan.axles.slice().sort((a, b) => a.position - b.position)
      const axle = sortedAxles[i]
      const axleNumber = loadGeometry.axlePositions.length - i
      const axleRole = loadGeometry.axlePositions.length === 2
        ? (axleNumber === 1 ? 'передняя / рулевая' : 'задняя / ведущая')
        : ''
      const isDraggable = plan.axles.length >= 2
      const isDragging = axleDrag?.id === axle.id
      const displayX = isDragging ? axleDrag!.x : x
      return <g
        key={axle.id}
        className={isDragging ? 'axle-dragging' : 'axle-drag-target'}
        pointerEvents={isDraggable ? 'all' : 'none'}
      >
        <rect
          x={displayX - 75}
          y={0}
          width={150}
          height={plan.vehicleWidth}
          fill="transparent"
          className="axle-hit-box"
          pointerEvents={isDraggable ? 'all' : 'none'}
          style={{ cursor: 'ew-resize' }}
          onPointerDown={e => beginAxleDrag(e, axle.id, displayX)}
        />
        <line x1={displayX} y1={0} x2={displayX} y2={plan.vehicleWidth} className="axle-line" pointerEvents="none" />
        <g className="axle-wheels" pointerEvents="none">
          <rect x={displayX - 58} y={-92} width="116" height="84" rx="24" className="axle-wheel axle-wheel-top" />
          <rect x={displayX - 58} y={plan.vehicleWidth + 8} width="116" height="84" rx="24" className="axle-wheel axle-wheel-bottom" />
          <rect x={displayX - 18} y={-18} width="36" height={plan.vehicleWidth + 36} rx="18" className="axle-bridge" />
          {axleNumber === 2 && <><rect x={displayX - 92} y={-92} width="24" height="84" rx="10" className="axle-wheel axle-wheel-inner-top" /><rect x={displayX + 68} y={-92} width="24" height="84" rx="10" className="axle-wheel axle-wheel-inner-top" /><rect x={displayX - 92} y={plan.vehicleWidth + 8} width="24" height="84" rx="10" className="axle-wheel axle-wheel-inner-bottom" /><rect x={displayX + 68} y={plan.vehicleWidth + 8} width="24" height="84" rx="10" className="axle-wheel axle-wheel-inner-bottom" /></>}
        </g>
        <circle cx={displayX} cy={plan.vehicleWidth + 42} r={46} className="axle-drag-handle" />
        <text x={displayX} y={plan.vehicleWidth + 16} textAnchor="middle" className="axle-drag-hint">↔</text>
        <rect x={displayX - 150} y={plan.vehicleWidth + 82} width="300" height="58" rx="12" className="axle-label-bg" />
        <text x={displayX} y={plan.vehicleWidth + 119} textAnchor="middle" className="axle-label">Ось {axleNumber}</text>
        {axleRole && <text x={displayX} y={plan.vehicleWidth + 151} textAnchor="middle" className="axle-role-label">{axleRole}</text>}
        {(() => {
          const load = loadGeometry.axleLoads.find(item => item.id === axle.id)
          if (!load) return null
          const loadText = loadGeometry.assumed
            ? 'Автоматически · не проверено'
            : load.loadKg == null
              ? 'ЦМ вне базы'
              : Math.round(load.loadKg).toLocaleString('ru-RU') + ' кг · ' + load.percent!.toFixed(0) + '%'
          const statusClass = load.overCapacity ? 'axle-load-badge danger' : load.loadKg == null ? 'axle-load-badge warning' : 'axle-load-badge'
          const subText = loadGeometry.assumed
            ? 'Уточните положение осей для расчёта'
            : load.loadKg == null
              ? 'Нагрузка не определена'
              : load.capacityKg > 0
              ? 'допуск ' + Math.round(load.capacityKg).toLocaleString('ru-RU') + ' кг'
              : 'допустимая нагрузка не указана'
          return <g className={statusClass}>
            <rect x={displayX - 210} y={plan.vehicleWidth + 285} width="420" height="86" rx="14" />
            <text x={displayX} y={plan.vehicleWidth + 321} textAnchor="middle" className="axle-load-value">{loadText}</text>
            <text x={displayX} y={plan.vehicleWidth + 351} textAnchor="middle" className="axle-load-note">{subText}</text>
          </g>
        })()}
      </g>
    })}
    {plan.pallets.length > 0 && <g>
      {rotationFeedback && <g className="cg-change" pointerEvents="none"><line x1={rotationFeedback.fromX} y1={rotationFeedback.fromY} x2={rotationFeedback.toX} y2={rotationFeedback.toY} markerEnd="url(#cgChangeArrow)" /><text x={(rotationFeedback.fromX + rotationFeedback.toX) / 2} y={(rotationFeedback.fromY + rotationFeedback.toY) / 2 - 35} textAnchor="middle">ЦМ после разворота</text></g>}<circle cx={loadGeometry.cgX} cy={loadGeometry.cgY} r="48" className={rotationFeedback ? "cg-marker cg-marker-changed" : "cg-marker"} />
      <line x1={loadGeometry.cgX - 72} y1={loadGeometry.cgY} x2={loadGeometry.cgX + 72} y2={loadGeometry.cgY} className="cg-cross" />
      <line x1={loadGeometry.cgX} y1={loadGeometry.cgY - 72} x2={loadGeometry.cgX} y2={loadGeometry.cgY + 72} className="cg-cross" />
      <rect x={loadGeometry.cgX + 70} y={loadGeometry.cgY - 105} width="430" height="78" rx="14" className="cg-label-bg" />
      <text x={loadGeometry.cgX + 285} y={loadGeometry.cgY - 54} textAnchor="middle" className="cg-label">ЦЕНТР МАССЫ</text>
    </g>}
    <text x={plan.vehicleLength - 20} y={-185} textAnchor="end" className="load-model-note">{loadGeometry.assumed ? 'Оси: автоматическая расчётная модель' : 'Оси: введены пользователем'}</text>
    {loadGeometry.axleLoads.length === 2 && <text x={plan.vehicleLength - 20} y={-145} textAnchor="end" className="axle-total-note">Суммарная масса груза: {Math.round(loadGeometry.totalWeight).toLocaleString('ru-RU')} кг</text>}
  </g>
})()}<g className="coordinate-system" pointerEvents="none"><line x1="0" y1={plan.vehicleWidth + 175} x2={plan.vehicleLength} y2={plan.vehicleWidth + 175} markerEnd="url(#axisArrow)" /><text x={plan.vehicleLength / 2} y={plan.vehicleWidth + 235} textAnchor="middle">X — ДЛИНА КУЗОВА →</text><line x1="-170" y1={plan.vehicleWidth} x2="-170" y2="0" markerEnd="url(#axisArrow)" /><text x="-245" y={plan.vehicleWidth / 2} textAnchor="middle" transform={`rotate(-90 -245 ${plan.vehicleWidth / 2})`}>Y — ШИРИНА ↑</text><text x="0" y={plan.vehicleWidth + 205} textAnchor="start">0 м</text><text x={plan.vehicleLength} y={plan.vehicleWidth + 205} textAnchor="end">{(plan.vehicleLength / 1000).toLocaleString('ru-RU')} м</text><text x="-195" y={plan.vehicleWidth + 20} textAnchor="end">0 м</text><text x="-195" y="20" textAnchor="end">{(plan.vehicleWidth / 1000).toLocaleString('ru-RU')} м</text><text x={plan.vehicleLength + 80} y={plan.vehicleWidth / 2} className="orientation-label">ПЕРЕД<br/>КАБИНА</text><text x="-20" y={plan.vehicleWidth / 2} textAnchor="end" className="orientation-label">ЗАДНИЕ<br/>ДВЕРИ</text></g></svg></div></section><section className="bottom-info"><div className="selected-card"><span className="mini-pallet">▦</span><div><span className="eyebrow">ВЫБРАНА ПАЛЛЕТА</span><b>Паллета #{selected?.id ?? '—'} <small>· {selected?.weight ?? '—'} кг</small></b>{selected && <><div className="pallet-actions"><button type="button" onClick={() => void rotateSelectedPallet()} disabled={!selected.rotatable || selected.length === selected.width}>↻ Развернуть паллету</button><label>Вес, кг <input type="text" inputMode="decimal" value={weightDraft} onChange={e => setWeightDraft(e.target.value.replace(',', '.'))} onBlur={() => {
                const parsed = Number(weightDraft)
                if (Number.isFinite(parsed) && parsed >= 1) void setSelectedPalletWeight(parsed)
              }} onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const parsed = Number(weightDraft)
                  if (Number.isFinite(parsed) && parsed >= 1) void setSelectedPalletWeight(parsed)
                }
              }} /></label></div><div className="compact-hint">Потяните паллету мышью или пальцем. Во время перемещения схема сразу показывает, можно ли поставить груз без пересечения.</div></>}{selected && <div className="pallet-details"><span><b>Габариты в кузове</b> · X: {(selected.length / 1000).toLocaleString('ru-RU')} м · Y: {(selected.width / 1000).toLocaleString('ru-RU')} м</span><span><b>Положение</b> · X: {(selected.x / 1000).toLocaleString('ru-RU')} м · Y: {(selected.y / 1000).toLocaleString('ru-RU')} м</span><span><b>Высота</b> · {(selected.height / 1000).toLocaleString('ru-RU')} м</span><span><b>Ориентация</b> · {orientation}</span></div>}</div>{conflictReason && <div className="conflict-note">⚠ {conflictReason}</div>}</div><div className="summary"><span className="summary-title">ПРОВЕРКИ · ЭТАП 1</span>{calculations.map(c => <div className={`check ${c.id === 'count' && c.status === 'VIOLATION' ? 'check-placement-alert' : ''}`} key={c.id}><span className={`dot ${statusClass[c.status]}`} /><div><b>{c.label}</b><small>{c.note}</small>{c.id === 'count' && c.status === 'VIOLATION' && <div className="placement-alert"><div className="placement-alert-top"><strong>Не помещается: {unplacedCount} шт.</strong><span>{placedCount} из {requestedCount}</span></div><div className="placement-progress"><span style={{ width: `${requestedCount ? Math.min(100, placedCount / requestedCount * 100) : 0}%` }} /></div></div>}</div><strong>{c.value}</strong><em className={statusClass[c.status]}>{statusText[c.status]}</em></div>)}</div>{vehicleFitSuggestion && <div className="vehicle-fit-card">
    <div className="vehicle-fit-title">Не весь груз помещается</div>
    <div className="vehicle-fit-main">Текущий кузов: {(vehicleFitSuggestion.currentLength / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} × {(vehicleFitSuggestion.currentWidth / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м</div>
    <div className="vehicle-fit-options">
      {vehicleFitSuggestion.lengthAtCurrentWidth != null && <div><b>Оставить ширину { (vehicleFitSuggestion.currentWidth / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) } м</b><span>нужна длина ≈ {(vehicleFitSuggestion.lengthAtCurrentWidth / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м</span></div>}
      {vehicleFitSuggestion.widthAtCurrentLength != null && <div><b>Оставить длину { (vehicleFitSuggestion.currentLength / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) } м</b><span>нужна ширина ≈ {(vehicleFitSuggestion.widthAtCurrentLength / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м</span></div>}
      {vehicleFitSuggestion.minimumHeight != null && <div><b>Нужна высота кузова</b><span>не менее {(vehicleFitSuggestion.minimumHeight / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м</span></div>}
    </div>
    <small>{vehicleFitSuggestion.note}</small>
  </div>}</section><div className="mode-note">2D схема · 3D — скоро</div></main>
}

function App() {
  const [tab, setTab] = useState<'assistant' | 'visual'>('assistant')
  return <div className="app-shell"><div className="mobile-tabs"><button onClick={() => setTab('assistant')} className={tab === 'assistant' ? 'active' : ''}>Ассистент</button><button onClick={() => setTab('visual')} className={tab === 'visual' ? 'active' : ''}>Схема</button></div><div className={`desktop-panel ${tab === 'assistant' ? 'mobile-show' : ''}`}><Assistant /></div><div className={`desktop-panel ${tab === 'visual' ? 'mobile-show' : ''}`}><Visualizer /></div></div>
}
export default App