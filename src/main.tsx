import { useRef, useState, type ReactNode } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod'
import { SpeechService } from './services'
import { useLoadPlanStore } from './store'
import type { CheckStatus, CargoGroup, LoadPlan } from './types'
import './styles.css'

const numberField = z.preprocess(v => typeof v === 'string' ? Number(v.replace(',', '.')) : v, z.number().finite())
const optionalNumberField = z.preprocess(v => v === '' || v === undefined ? undefined : typeof v === 'string' ? Number(v.replace(',', '.')) : v, z.number().finite().optional())
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
  obstacleX: numberField.pipe(z.number().min(0)), obstacleY: numberField.pipe(z.number().min(0)), obstacleLength: numberField.pipe(z.number().min(0)), obstacleWidth: numberField.pipe(z.number().min(0)),
  unavailable: z.boolean(), unavailableX: numberField.pipe(z.number().min(0)), unavailableY: numberField.pipe(z.number().min(0)), unavailableLength: numberField.pipe(z.number().min(0)), unavailableWidth: numberField.pipe(z.number().min(0)), axleCount: z.coerce.number().int().min(0).max(8),
  cargoGroups: z.array(cargoGroupSchema).min(1).max(8),
})
type FormValues = z.infer<typeof schema>
const statusClass: Record<CheckStatus, string> = { CHECKED: 'status-ok', VIOLATION: 'status-bad', NOT_CHECKED: 'status-idle' }
const statusText: Record<CheckStatus, string> = { CHECKED: 'ПРОВЕРЕНО', VIOLATION: 'НАРУШЕНИЕ', NOT_CHECKED: 'НЕ ПРОВЕРЕНО' }
const presets = [
  ['EUR 1,2 × 0,8 м', 1.2, 0.8], ['1,2 × 1,0 м', 1.2, 1.0], ['1,2 × 1,2 м', 1.2, 1.2], ['Свои размеры', 0, 0],
] as const

function Field({ label, input, error }: { label: string; input: ReactNode; error?: string }) {
  return <label className="field"><span>{label}</span>{input}{error && <em>{error}</em>}</label>
}

function PlanForm() {
  const setPlan = useLoadPlanStore(s => s.setPlan)
  const [listening, setListening] = useState(false)
  const [recognized, setRecognized] = useState('')
  const { register, handleSubmit, setValue, watch, control, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      vehicleLength: 6, vehicleWidth: 2.05, vehicleHeight: 2.2, coolerLength: 1.23, coolerHeight: 0.29, coolerProjection: 0.68, payloadCapacityKg: undefined, doorWidth: 0.23, gap: 0,
      hasObstacle: false, obstacleMode: 'AUTO', obstacleX: 5.23, obstacleY: 0.7, obstacleLength: 0.42, obstacleWidth: 0.54, unavailable: false, unavailableX: 2.5, unavailableY: 0, unavailableLength: 1.0, unavailableWidth: 2.05, axleCount: 0,
      cargoGroups: [{ name: 'EUR паллета', length: 1.2, width: 0.8, height: 0, weight: 450, count: 10, rotatable: true, stackable: false }],
    },
  })
  const { fields, append, remove } = useFieldArray({ control, name: 'cargoGroups' })
  const [presetByGroup, setPresetByGroup] = useState<number[]>([0])
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
    const coolerProjection = v.coolerProjection * 1000
    const cooler = {
      x: Math.max(0, v.vehicleLength * 1000 - coolerProjection),
      y: Math.max(0, (v.vehicleWidth * 1000 - coolerLength) / 2),
      length: coolerProjection,
      width: coolerLength,
    }
    const obstacleLength = v.obstacleLength * 1000
    const obstacleWidth = v.obstacleWidth * 1000
    const autoObstacle = {
      x: Math.max(v.doorWidth * 1000 + v.gap * 1000, v.vehicleLength * 1000 - obstacleLength - 200),
      y: Math.max(0, v.vehicleWidth * 1000 - obstacleWidth - 200),
      length: obstacleLength,
      width: obstacleWidth,
    }
    const customObstacle = {
      x: v.obstacleX * 1000,
      y: v.obstacleY * 1000,
      length: obstacleLength,
      width: obstacleWidth,
    }
    const customObstacles = v.hasObstacle && obstacleLength > 0 && obstacleWidth > 0
      ? [v.obstacleMode === 'FIXED' ? customObstacle : autoObstacle]
      : []
    const obstacles = [cooler, ...customObstacles]
    const unavailable = v.unavailable
      ? [{ x: v.unavailableX * 1000, y: v.unavailableY * 1000, length: v.unavailableLength * 1000, width: v.unavailableWidth * 1000 }]
      : []
    const gaps = v.gap ? [{ x: v.doorWidth * 1000, y: 0, length: v.gap * 1000, width: v.vehicleWidth * 1000 }] : []
    const blockedZones = [...obstacles, ...unavailable, ...gaps]
    const overlaps = (a: { x: number; y: number; length: number; width: number }, b: { x: number; y: number; length: number; width: number }) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    const canPlace = (x: number, y: number, length: number, width: number, placed: Array<{ x: number; y: number; length: number; width: number }>) => {
      const candidate = { x, y, length, width }
      if (x < 0 || y < 0 || x + length > v.vehicleLength * 1000 || y + width > v.vehicleWidth * 1000) return false
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
    const scoreCandidate = (x: number, y: number, length: number, width: number, placed: typeof placements) => {
      const right = x + length
      const bottom = y + width
      const wallContact = (x === 0 ? 1 : 0) + (y === 0 ? 1 : 0) +
        (right === v.vehicleLength * 1000 ? 1 : 0) + (bottom === v.vehicleWidth * 1000 ? 1 : 0)
      const adjacent = [...placed, ...blocked].reduce((score, p) => {
        const verticalTouch = (right === p.x || x === p.x + p.length) && y < p.y + p.width && bottom > p.y
        const horizontalTouch = (bottom === p.y || y === p.y + p.width) && x < p.x + p.length && right > p.x
        return score + (verticalTouch ? 2 : 0) + (horizontalTouch ? 2 : 0)
      }, 0)
      // Lower y/x keeps the plan easy to unload; adjacency reduces fragmented pockets.
      return wallContact * 1000000 + adjacent * 1000 - y - x * 0.001
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
          if (!canPlace(point.x, point.y, length, width, placements)) continue
          const score = scoreCandidate(point.x, point.y, length, width, placements) + orientationBonus
          if (!best || score > best.score) best = { ...point, length, width, score }
        }
      }
      if (best) placements.push({ x: best.x, y: best.y, length: best.length, width: best.width, group: item.group })
    }

    const pallets = placements.map((p, i) => ({
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
      obstacles: [{ id: 'cooler', ...cooler, label: 'Холодильная установка' }, ...customObstacles.map((o, index) => ({ id: `obstacle-${index + 1}`, ...o, label: v.obstacleMode === 'FIXED' ? 'Препятствие · фиксированное' : 'Препятствие · авто' }))],
      unavailableZones: v.unavailable ? [{ id: 'unavailable', x: v.unavailableX * 1000, y: v.unavailableY * 1000, length: v.unavailableLength * 1000, width: v.unavailableWidth * 1000, label: 'Недоступная зона' }] : [],
      axles: Array.from({ length: v.axleCount }, (_, i) => ({ id: `axle-${i + 1}`, position: v.vehicleLength * 1000 * (i + 1) / (v.axleCount + 1), capacityKg: 0 })),
      cargoGroups,
      pallets,
    }
    void setPlan(plan)
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
    <div className="field-grid three"><Field label="Длина, м" input={<input inputMode="decimal" placeholder="1,23" {...register('coolerLength')} />} error={errors.coolerLength?.message} /><Field label="Высота, м" input={<input inputMode="decimal" placeholder="0,29" {...register('coolerHeight')} />} error={errors.coolerHeight?.message} /><Field label="Выпирает, м" input={<input inputMode="decimal" placeholder="0,68" {...register('coolerProjection')} />} error={errors.coolerProjection?.message} /></div>
    <div className="field-grid three"><Field label="Двери, м" input={<input inputMode="decimal" placeholder="0,23" {...register('doorWidth')} />} error={errors.doorWidth?.message} /><Field label="Зазор, м" input={<input inputMode="decimal" placeholder="0" {...register('gap')} />} error={errors.gap?.message} /><Field label="Грузоподъёмность, кг" input={<input {...register('payloadCapacityKg')} placeholder="не указана" />} error={errors.payloadCapacityKg?.message} /></div>
    <div className="section-label cargo-label">Препятствия и недоступные зоны</div>
    <label className="check-field"><input type="checkbox" {...register('hasObstacle')} /> Есть препятствие</label>
    {watch('hasObstacle') && <>
      <div className="field-grid two obstacle-mode-row"><Field label="Положение" input={<select {...register('obstacleMode')}><option value="AUTO">Автоматически — система выберет место</option><option value="FIXED">Фиксированно — использовать X/Y</option></select>} error={errors.obstacleMode?.message} /><Field label="Описание" input={<input value={watch('obstacleMode') === 'FIXED' ? 'Объект нельзя перемещать' : 'Объект можно перемещать'} readOnly />} /></div>
      <div className="field-grid four"><Field label="Длина, м" input={<input inputMode="decimal" {...register('obstacleLength')} />} error={errors.obstacleLength?.message} /><Field label="Ширина, м" input={<input inputMode="decimal" {...register('obstacleWidth')} />} error={errors.obstacleWidth?.message} />{watch('obstacleMode') === 'FIXED' && <><Field label="X, м" input={<input inputMode="decimal" {...register('obstacleX')} />} error={errors.obstacleX?.message} /><Field label="Y, м" input={<input inputMode="decimal" {...register('obstacleY')} />} error={errors.obstacleY?.message} /></>}</div>
    </>}
    <label className="check-field"><input type="checkbox" {...register('unavailable')} /> Есть недоступная зона</label>
    <div className="field-grid four"><Field label="X, м" input={<input inputMode="decimal" {...register('unavailableX')} />} error={errors.unavailableX?.message} /><Field label="Y, м" input={<input inputMode="decimal" {...register('unavailableY')} />} error={errors.unavailableY?.message} /><Field label="Длина, м" input={<input inputMode="decimal" {...register('unavailableLength')} />} error={errors.unavailableLength?.message} /><Field label="Ширина, м" input={<input inputMode="decimal" {...register('unavailableWidth')} />} error={errors.unavailableWidth?.message} /></div>
    <div className="section-label cargo-label">Автомобиль и оси</div>
    <Field label="Количество осей" input={<input {...register('axleCount')} />} error={errors.axleCount?.message} />
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
  const { plan, calculations, selectedPallet, setSelectedPallet } = useLoadPlanStore()
  const [zoom, setZoom] = useState(1)
  if (!plan) return <main className="visualizer empty"><div className="empty-art">▱ ▱</div><h2>Схема загрузки появится здесь</h2><p>Нажмите «Попробовать пример» или заполните параметры вручную.</p></main>
  const selected = plan.pallets.find(p => p.id === selectedPallet)
  const orientation = selected ? (selected.length >= selected.width ? 'По длине кузова' : 'Повернута на 90°') : '—'
  const conflicts = plan.pallets.filter((p, i) => {
    const intersects = (a: typeof p, b: typeof p) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    return p.x < 0 || p.y < 0 || p.x + p.length > plan.vehicleLength || p.y + p.width > plan.vehicleWidth ||
      plan.obstacles.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.unavailableZones.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.gaps.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.pallets.slice(i + 1).some(q => intersects(p, q))
  })
  const conflictReason = selected && conflicts.some(p => p.id === selected.id)
    ? (selected.x + selected.length > plan.vehicleLength || selected.y + selected.width > plan.vehicleWidth ? 'Выходит за границы кузова'
      : plan.obstacles.some(o => selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Пересекает препятствие'
      : plan.unavailableZones.some(o => selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Попадает в недоступную зону'
      : plan.gaps.some(o => selected.x < o.x + o.length && selected.x + selected.length > o.x && selected.y < o.y + o.width && selected.y + selected.width > o.y) ? 'Попадает в зону зазора'
      : 'Пересекает другую паллету')
    : ''

  const placementCheck = calculations.find(c => c.id === 'count')
  const placementViolation = placementCheck?.status === 'VIOLATION'
  const placementParts = placementCheck?.value.match(/^(\d+) \/ (\d+)$/)
  const placedCount = placementParts ? Number(placementParts[1]) : plan.pallets.length
  const requestedCount = placementParts ? Number(placementParts[2]) : plan.pallets.length
  const unplacedCount = Math.max(0, requestedCount - placedCount)
  return <main className="visualizer"><header className="visual-header"><div><span className="eyebrow">ПЛАН ЗАГРУЗКИ</span><h2>Кузов · {plan.vehicleLength} × {plan.vehicleWidth} × {plan.vehicleHeight} мм</h2></div><div className="header-stat"><b>{plan.pallets.length}/{plan.cargoGroups.reduce((sum, g) => sum + g.count, 0)}</b><span>паллет</span></div></header><section className="canvas-wrap"><div className="map-toolbar"><span>МАСШТАБ <b>{Math.round(zoom * 100)}%</b></span><div><button type="button" onClick={() => setZoom(z => Math.max(.75, Number((z - .25).toFixed(2))))} aria-label="Уменьшить">−</button><button type="button" onClick={() => setZoom(1)} aria-label="Сбросить масштаб">100%</button><button type="button" onClick={() => setZoom(z => Math.min(2.5, Number((z + .25).toFixed(2))))} aria-label="Увеличить">+</button></div></div><div className="svg-viewport"><svg viewBox={`-500 -280 ${plan.vehicleLength + 1000} ${plan.vehicleWidth + 750}`} style={{ transform: `scale(${zoom})` }} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Вид сверху на кузов с паллетами" className="truck-svg"><defs><pattern id="grid" width="500" height="500" patternUnits="userSpaceOnUse"><path d="M 500 0 L 0 0 0 500" fill="none" stroke="#dbe5ea" strokeWidth="8" /></pattern><pattern id="gridSmall" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#edf2f3" strokeWidth="3" /></pattern><marker id="axisArrow" markerWidth="14" markerHeight="14" refX="10" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z" className="axis-arrow" /></marker></defs><text x={plan.vehicleLength / 2} y="-135" textAnchor="middle" className="dimension">{plan.vehicleLength.toLocaleString('ru-RU')} мм</text><path d={`M0 -80h${plan.vehicleLength}`} className="dimension-line" /><text x="-330" y={plan.vehicleWidth / 2} textAnchor="middle" transform={`rotate(-90 -330 ${plan.vehicleWidth / 2})`} className="dimension">{plan.vehicleWidth.toLocaleString('ru-RU')} мм</text><rect x="0" y="0" width={plan.vehicleLength} height={plan.vehicleWidth} rx="28" fill="url(#gridSmall)" className="truck-body" /><rect x="0" y="0" width={plan.vehicleLength} height={plan.vehicleWidth} fill="url(#grid)" className="truck-grid-major" pointerEvents="none" /><g className="meter-scale" pointerEvents="none">{Array.from({ length: Math.floor(plan.vehicleLength / 1000) + 1 }, (_, i) => <g key={i}><line x1={i * 1000} y1={plan.vehicleWidth + 35} x2={i * 1000} y2={plan.vehicleWidth + 95} /><text x={i * 1000} y={plan.vehicleWidth + 125} textAnchor="middle">{i} м</text></g>)}</g><rect x="0" y="0" width={plan.doors[0]?.length ?? 0} height={plan.vehicleWidth} fill="#d9e4e8" opacity=".7" /><path d={`M0 0H${plan.doors[0]?.length ?? 0} M0 ${plan.vehicleWidth}H${plan.doors[0]?.length ?? 0}`} className="door-opening" /><path d={`M0 0L${Math.max(80, (plan.doors[0]?.length ?? 0) * .8)} ${plan.vehicleWidth / 2}L0 ${plan.vehicleWidth}`} className="door-leaf" />{plan.gaps.map(g => <g key={g.id}><rect x={g.x} y={g.y} width={g.length} height={g.width} className="gap-zone" /><text x={g.x + g.length / 2} y={g.width / 2} textAnchor="middle" className="gap-label">ЗАЗОР</text></g>)}<path d={`M0 150h140 M0 ${Math.max(150, plan.vehicleWidth - 150)}h140`} className="door" /><text x={(plan.doors[0]?.length ?? 0) / 2} y={plan.vehicleWidth / 2} textAnchor="middle" transform={`rotate(-90 ${(plan.doors[0]?.length ?? 0) / 2} ${plan.vehicleWidth / 2})`} className="door-label">ДВЕРИ</text>{plan.obstacles.map(o => <g key={o.id}><rect x={o.x} y={o.y} width={o.length} height={o.width} rx="24" className="obstacle" /><text x={o.x + o.length / 2} y={o.y + o.width / 2} textAnchor="middle" className="obstacle-label">{o.label}</text></g>)}{plan.unavailableZones.map(o => <g key={o.id}><rect x={o.x} y={o.y} width={o.length} height={o.width} rx="16" className="unavailable-zone" /><text x={o.x + o.length / 2} y={o.y + o.width / 2} textAnchor="middle" className="obstacle-label">{o.label}</text></g>)}{plan.pallets.map(p => <g key={p.id} onClick={() => setSelectedPallet(p.id)} className="pallet-group"><rect x={p.x} y={p.y} width={p.length} height={p.width} rx="18" className={`pallet ${selectedPallet === p.id ? 'selected' : ''} ${conflicts.some(c => c.id === p.id) ? 'pallet-conflict' : ''}`} /><text x={p.x + p.length / 2} y={p.y + p.width / 2 - 12} textAnchor="middle" className="pallet-number">{p.id}</text><text x={p.x + p.length / 2} y={p.y + p.width / 2 + 62} textAnchor="middle" className="pallet-size">{(p.length / 1000).toLocaleString('ru-RU')} × {(p.width / 1000).toLocaleString('ru-RU')} м</text>{selectedPallet === p.id && <><DimLine x1={p.x} y1={p.y - 70} x2={p.x + p.length} y2={p.y - 70} label={`${(p.length / 1000).toLocaleString('ru-RU')} м`} offset={-18} /><DimLine x1={p.x - 70} y1={p.y} x2={p.x - 70} y2={p.y + p.width} label={`${(p.width / 1000).toLocaleString('ru-RU')} м`} offset={-18} /><text x={p.x + p.length / 2} y={p.y + p.width + 115} textAnchor="middle" className="coord-label">X {(p.x / 1000).toLocaleString('ru-RU')} м · Y {(p.y / 1000).toLocaleString('ru-RU')} м</text></>}</g>)}<g className="coordinate-system" pointerEvents="none"><line x1="0" y1={plan.vehicleWidth + 175} x2={plan.vehicleLength} y2={plan.vehicleWidth + 175} markerEnd="url(#axisArrow)" /><text x={plan.vehicleLength / 2} y={plan.vehicleWidth + 235} textAnchor="middle">X — ДЛИНА КУЗОВА →</text><line x1="-170" y1={plan.vehicleWidth} x2="-170" y2="0" markerEnd="url(#axisArrow)" /><text x="-245" y={plan.vehicleWidth / 2} textAnchor="middle" transform={`rotate(-90 -245 ${plan.vehicleWidth / 2})`}>Y — ШИРИНА ↑</text><text x="0" y={plan.vehicleWidth + 205} textAnchor="start">0 м</text><text x={plan.vehicleLength} y={plan.vehicleWidth + 205} textAnchor="end">{(plan.vehicleLength / 1000).toLocaleString('ru-RU')} м</text><text x="-195" y={plan.vehicleWidth + 20} textAnchor="end">0 м</text><text x="-195" y="20" textAnchor="end">{(plan.vehicleWidth / 1000).toLocaleString('ru-RU')} м</text><text x={plan.vehicleLength + 80} y={plan.vehicleWidth / 2} className="orientation-label">ПЕРЕД<br/>КАБИНА</text><text x="-20" y={plan.vehicleWidth / 2} textAnchor="end" className="orientation-label">ЗАДНИЕ<br/>ДВЕРИ</text></g></svg></div></section><section className="bottom-info"><div className="selected-card"><span className="mini-pallet">▦</span><div><span className="eyebrow">ВЫБРАНА ПАЛЛЕТА</span><b>Паллета #{selected?.id ?? '—'} <small>· {selected?.weight ?? '—'} кг</small></b>{selected && <div className="pallet-details"><span>Размер: {(selected.length / 1000).toLocaleString('ru-RU')} × {(selected.width / 1000).toLocaleString('ru-RU')} м</span><span>Высота: {(selected.height / 1000).toLocaleString('ru-RU')} м</span><span>Координаты: X {(selected.x / 1000).toLocaleString('ru-RU')}, Y {(selected.y / 1000).toLocaleString('ru-RU')} м</span><span>Ориентация: {orientation}</span></div>}</div>{conflictReason && <div className="conflict-note">⚠ {conflictReason}</div>}</div><div className="summary"><span className="summary-title">ПРОВЕРКИ · ЭТАП 1</span>{calculations.map(c => <div className={`check ${c.id === 'count' && c.status === 'VIOLATION' ? 'check-placement-alert' : ''}`} key={c.id}><span className={`dot ${statusClass[c.status]}`} /><div><b>{c.label}</b><small>{c.note}</small>{c.id === 'count' && c.status === 'VIOLATION' && <div className="placement-alert"><div className="placement-alert-top"><strong>Не помещается: {unplacedCount} шт.</strong><span>{placedCount} из {requestedCount}</span></div><div className="placement-progress"><span style={{ width: `${requestedCount ? Math.min(100, placedCount / requestedCount * 100) : 0}%` }} /></div></div>}</div><strong>{c.value}</strong><em className={statusClass[c.status]}>{statusText[c.status]}</em></div>)}</div></section><div className="mode-note">2D схема · 3D — скоро</div></main>
}

function App() {
  const [tab, setTab] = useState<'assistant' | 'visual'>('assistant')
  return <div className="app-shell"><div className="mobile-tabs"><button onClick={() => setTab('assistant')} className={tab === 'assistant' ? 'active' : ''}>Ассистент</button><button onClick={() => setTab('visual')} className={tab === 'visual' ? 'active' : ''}>Схема</button></div><div className={`desktop-panel ${tab === 'assistant' ? 'mobile-show' : ''}`}><Assistant /></div><div className={`desktop-panel ${tab === 'visual' ? 'mobile-show' : ''}`}><Visualizer /></div></div>
}
export default App