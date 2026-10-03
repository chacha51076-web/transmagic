import type { Calculation, LoadPlan, Pallet } from './types'

const demoPallet = (id: number, x: number, y: number): Pallet => ({
  id, length: 1200, width: 800, height: 0, weight: 450, x, y, rotatable: true, stackable: false,
})

export const AssistantService = {
  async createDemo(): Promise<LoadPlan> {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const pallets = [
      demoPallet(1, 0, 0), demoPallet(2, 1200, 0), demoPallet(3, 2400, 0), demoPallet(4, 3600, 0),
      { ...demoPallet(5, 4800, 0), length: 800, width: 1200 },
      demoPallet(6, 0, 1200), demoPallet(7, 1200, 1200), demoPallet(8, 2400, 1200),
      demoPallet(9, 3600, 1200), demoPallet(10, 4800, 1200),
    ]
    return {
      vehicleLength: 6000, vehicleWidth: 2050, vehicleHeight: 2200,
      payloadCapacityKg: undefined,
      doors: [{ id: 'rear', x: 0, y: 0, length: 230, width: 2050, label: 'Двери' }],
      gaps: [], obstacles: [{ id: 'cooler', x: 5320, y: 380, length: 680, width: 1290, height: 290, label: 'Холодильная установка', blocksFloor: false }],
      unavailableZones: [], axles: [{ id: 'axle-1', position: 4200, capacityKg: 0, source: 'AUTO' }, { id: 'axle-2', position: 5400, capacityKg: 0, source: 'AUTO' }],
      cargoGroups: [{ id: 'eur', name: 'EUR паллета', length: 1200, width: 800, height: 0, weight: 450, count: 10, rotatable: true, stackable: false }],
      pallets,
    }
  },
}

export type PlacementVariant = 'BALANCED' | 'REAR' | 'AXLE'

export interface StaticLoadAnalysis {
  totalWeight: number
  cgX: number
  cgY: number
  axlePositions: number[]
  axleLoads: number[]
  valid: boolean
  reason?: string
}

export const calculateStaticLoad = (plan: LoadPlan): StaticLoadAnalysis => {
  const items = [
    ...plan.pallets.map(p => ({ weight: p.weight, x: p.x + p.length / 2, y: p.y + p.width / 2 })),
    ...plan.obstacles
      .filter(o => (o.weight ?? 0) > 0)
      .map(o => ({ weight: o.weight ?? 0, x: o.x + o.length / 2, y: o.y + o.width / 2 })),
  ]
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
  const cgX = totalWeight > 0
    ? items.reduce((sum, item) => sum + item.weight * item.x, 0) / totalWeight
    : plan.vehicleLength / 2
  const cgY = totalWeight > 0
    ? items.reduce((sum, item) => sum + item.weight * item.y, 0) / totalWeight
    : plan.vehicleWidth / 2
  const axles = plan.axles.slice().sort((a, b) => a.position - b.position)
  const axlePositions = axles.map(axle => axle.position)

  if (axlePositions.length < 2 || totalWeight <= 0) {
    return { totalWeight, cgX, cgY, axlePositions, axleLoads: [], valid: false, reason: 'Недостаточно данных для расчёта' }
  }
  const first = axlePositions[0]
  const last = axlePositions[axlePositions.length - 1]
  if (cgX < first || cgX > last) {
    return { totalWeight, cgX, cgY, axlePositions, axleLoads: [], valid: false, reason: 'Центр массы находится вне базы осей' }
  }

  const loads = axlePositions.map(() => 0)
  const rightIndex = Math.max(0, axlePositions.findIndex(position => position >= cgX))
  const leftIndex = Math.max(0, rightIndex - 1)

  if (axlePositions[rightIndex] === cgX) {
    loads[rightIndex] = totalWeight
  } else {
    const left = axlePositions[leftIndex]
    const right = axlePositions[rightIndex]
    const span = right - left
    if (span <= 0) {
      return { totalWeight, cgX, cgY, axlePositions, axleLoads: [], valid: false, reason: 'Некорректное расстояние между осями' }
    }
    loads[leftIndex] = totalWeight * (right - cgX) / span
    loads[rightIndex] = totalWeight * (cgX - left) / span
  }

  const valid = loads.every(load => Number.isFinite(load) && load >= -0.001)
  return {
    totalWeight,
    cgX,
    cgY,
    axlePositions,
    axleLoads: valid ? loads.map(load => Math.max(0, load)) : [],
    valid,
    reason: valid ? undefined : 'Получена некорректная реакция оси',
  }
}

const normalizeFixedEquipment = (plan: LoadPlan): LoadPlan => ({
  ...plan,
  obstacles: plan.obstacles.map(obstacle => obstacle.id === 'cooler'
    ? {
        ...obstacle,
        x: Math.max(0, plan.vehicleLength - obstacle.length),
        y: Math.max(0, (plan.vehicleWidth - obstacle.width) / 2),
        height: obstacle.height ?? 290,
        blocksFloor: false,
      }
    : obstacle),
})

export const PlacementService = {
  createVariants(plan: LoadPlan): LoadPlan[] {
    plan = normalizeFixedEquipment(plan)

    const blocked = [
      ...plan.obstacles.filter(o => o.blocksFloor !== false),
      ...plan.unavailableZones,
      ...plan.gaps,
    ]

    const verticalZones = plan.obstacles.filter(o => (o.height ?? 0) > 0)
    const overlaps = (a: {x:number;y:number;length:number;width:number}, b: {x:number;y:number;length:number;width:number}) =>
      a.x < b.x + b.length && a.x + a.length > b.x &&
      a.y < b.y + b.width && a.y + a.width > b.y

    const verticalClear = (candidate: { x: number; y: number; length: number; width: number; height: number }) => {
      if (candidate.height <= 0) return true
      if (candidate.height > plan.vehicleHeight) return false
      return !verticalZones.some(zone => {
        const overlap =
          candidate.x < zone.x + zone.length &&
          candidate.x + candidate.length > zone.x &&
          candidate.y < zone.y + zone.width &&
          candidate.y + candidate.width > zone.y
        return overlap && candidate.height > plan.vehicleHeight - (zone.height ?? 0)
      })
    }

    const axlePositions = plan.axles.slice().sort((a, b) => a.position - b.position)
    const targetX = axlePositions.length >= 2
      ? (axlePositions[0].position + axlePositions[axlePositions.length - 1].position) / 2
      : plan.vehicleLength / 2
    const targetY = plan.vehicleWidth / 2

    const items = plan.cargoGroups
      .flatMap((group, groupIndex) =>
        Array.from({ length: group.count }, (_, itemIndex) => ({ group, groupIndex, itemIndex }))
      )
      .sort((a, b) => {
        const byArea = b.group.length * b.group.width - a.group.length * a.group.width
        if (byArea !== 0) return byArea
        const byWeight = b.group.weight - a.group.weight
        if (byWeight !== 0) return byWeight
        return b.group.height - a.group.height
      })

    const candidateAxisValues = (size: number, axis: 'x' | 'y', placed: Pallet[]) => {
      const max = axis === 'x' ? plan.vehicleLength - size : plan.vehicleWidth - size
      const values = new Set<number>([0, Math.max(0, max)])

      // Regular 50 mm grid prevents the solver from getting trapped in
      // sparse/isolated candidate points. For this UI-sized problem the
      // search remains small enough for the browser.
      const step = 50
      for (let value = 0; value <= max; value += step) values.add(value)
      if (max % step !== 0) values.add(max)

      for (const rect of [...placed, ...blocked]) {
        const edge = axis === 'x'
          ? [rect.x, rect.x + rect.length - size, rect.x + rect.length]
          : [rect.y, rect.y + rect.width - size, rect.y + rect.width]
        edge.forEach(value => values.add(Math.max(0, Math.min(max, Math.round(value / 50) * 50))))
      }

      return [...values].sort((a, b) => a - b)
    }

    const isFree = (candidate: Pallet, placed: Pallet[]) =>
      candidate.x >= 0 &&
      candidate.y >= 0 &&
      candidate.x + candidate.length <= plan.vehicleLength &&
      candidate.y + candidate.width <= plan.vehicleWidth &&
      verticalClear(candidate) &&
      !blocked.some(rect => overlaps(candidate, rect)) &&
      !placed.some(rect => overlaps(candidate, rect))

    const scoreCandidate = (candidate: Pallet, placed: Pallet[], mode: PlacementVariant) => {
      const cx = candidate.x + candidate.length / 2
      const cy = candidate.y + candidate.width / 2

      const load = calculateStaticLoad({
        ...plan,
        pallets: [...placed, candidate],
      })

      const target =
        mode === 'REAR'
          ? Math.min(targetX, plan.vehicleLength * 0.42)
          : targetX

      const cgPenalty = Math.abs(load.cgX - target)
      const sidePenalty = Math.abs(load.cgY - targetY)

      let capacityPenalty = 0
      if (load.valid && axlePositions.length >= 2) {
        load.axleLoads.forEach((value, index) => {
          const capacity = axlePositions[index]?.capacityKg ?? 0
          if (capacity > 0 && value > capacity) {
            capacityPenalty += (value - capacity) * 800
          }
        })
      }

      let contact = 0
      if (candidate.x === 0 || candidate.x + candidate.length === plan.vehicleLength) contact += 400
      if (candidate.y === 0 || candidate.y + candidate.width === plan.vehicleWidth) contact += 400

      const adjacent = [...placed, ...blocked].reduce((sum, rect) => {
        const horizontalTouch =
          (candidate.x + candidate.length === rect.x || candidate.x === rect.x + rect.length) &&
          candidate.y < rect.y + rect.width &&
          candidate.y + candidate.width > rect.y
        const verticalTouch =
          (candidate.y + candidate.width === rect.y || candidate.y === rect.y + rect.width) &&
          candidate.x < rect.x + rect.length &&
          candidate.x + candidate.length > rect.x
        return sum + (horizontalTouch ? 1 : 0) + (verticalTouch ? 1 : 0)
      }, 0)

      const centerBias = mode === 'BALANCED'
        ? Math.abs(cx - targetX) * 0.4
        : mode === 'AXLE'
          ? Math.abs(cx - targetX) * 0.9
          : cx * 0.06

      const orientationBias = mode === 'REAR'
        ? (candidate.length > candidate.width ? 500 : 0)
        : mode === 'AXLE'
          ? (candidate.length < candidate.width ? 500 : 0)
          : 0

      return (
        contact +
        adjacent * 80 +
        orientationBias -
        cgPenalty * 0.035 -
        sidePenalty * 0.08 -
        capacityPenalty -
        centerBias -
        cy * 0.012
      )
    }

    const buildVariant = (mode: PlacementVariant) => {
      const placed: Pallet[] = []

      for (const item of items) {
        const orientations = item.group.rotatable && item.group.length !== item.group.width
          ? mode === 'REAR'
            ? [[item.group.length, item.group.width], [item.group.width, item.group.length]]
            : [[item.group.width, item.group.length], [item.group.length, item.group.width]]
          : [[item.group.length, item.group.width]]

        let best: Pallet | undefined
        let bestScore = -Infinity

        for (const [length, width] of orientations) {
          const xs = candidateAxisValues(length, 'x', placed)
          const ys = candidateAxisValues(width, 'y', placed)

          for (const y of ys) {
            for (const x of xs) {
              const candidate: Pallet = {
                id: placed.length + 1,
                length,
                width,
                height: item.group.height,
                weight: item.group.weight,
                x,
                y,
                rotatable: item.group.rotatable,
                stackable: false,
              }

              if (!isFree(candidate, placed)) continue

              const score = scoreCandidate(candidate, placed, mode)

              // Primary rule: choose a feasible position. Secondary rule:
              // compact packing + sensible centre of mass. This keeps the
              // solver from producing isolated 2/10 or 3/10 "solutions".
              if (!best || score > bestScore) {
                best = candidate
                bestScore = score
              }
            }
          }
        }

        if (best) placed.push(best)
      }

      return placed.map((p, index) => ({ ...p, id: index + 1 }))
    }

    const variants = (['BALANCED', 'REAR', 'AXLE'] as PlacementVariant[])
      .map(mode => ({
        ...plan,
        pallets: buildVariant(mode),
      }))

    // The number of placed pallets is the hard feasibility criterion.
    // Only after maximizing that count do we compare quality of the layout.
    const maxPlaced = Math.max(...variants.map(variant => variant.pallets.length), 0)
    const unique = new Map<string, LoadPlan>()

    for (const variant of variants.filter(item => item.pallets.length === maxPlaced)) {
      const signature = variant.pallets
        .slice()
        .sort((a, b) => a.id - b.id)
        .map(p => [p.length, p.width, p.x, p.y].join(':'))
        .join('|')

      if (!unique.has(signature)) unique.set(signature, variant)
    }

    return [...unique.values()].slice(0, 3)
  }
}

export const SpeechService = {
  async listen(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 700))
    return 'Добавить 10 европаллет по 450 килограммов'
  },
  isSupported(): boolean {
    return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  },
}

export const SolverService = {
  async summarize(plan: LoadPlan): Promise<Calculation[]> {
    await new Promise((resolve) => setTimeout(resolve, 180))
    const fixedWeight = plan.obstacles.reduce((sum, o) => sum + (o.weight ?? 0), 0)
    const totalWeight = plan.pallets.reduce((sum, p) => sum + p.weight, 0) + fixedWeight
    const requestedWeight = plan.cargoGroups.reduce((sum, group) => sum + group.weight * group.count, 0)
    const occupied = plan.pallets.reduce((sum, p) => sum + p.length * p.width, 0) / 1_000_000
    const intersects = (a: Pallet, b: Pallet) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    const geometryViolation = plan.pallets.some((p, i) =>
      p.x < 0 || p.y < 0 || p.x + p.length > plan.vehicleLength || p.y + p.width > plan.vehicleWidth ||
      plan.obstacles.filter(o => o.blocksFloor !== false).some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.obstacles.some(o => (o.height ?? 0) > 0 &&
        p.height > plan.vehicleHeight - (o.height ?? 0) &&
        p.x < o.x + o.length && p.x + p.length > o.x &&
        p.y < o.y + o.width && p.y + p.width > o.y
      ) ||
      plan.unavailableZones.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.gaps.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.pallets.slice(i + 1).some(q => intersects(p, q))
    )
    const requestedCount = plan.cargoGroups.reduce((sum, group) => sum + group.count, 0)
    const unplacedCount = Math.max(0, requestedCount - plan.pallets.length)
    const placementViolation = geometryViolation || unplacedCount > 0
    const maxCargoHeight = plan.pallets.reduce((max, p) => Math.max(max, p.height), 0)
    const hasHeightData = plan.vehicleHeight > 0 && maxCargoHeight > 0

    // Расчётный центр тяжести и распределение веса по осевой базе.
    const staticLoad = calculateStaticLoad(plan)
    const sortedPlanAxles = plan.axles.slice().sort((a, b) => a.position - b.position)
    const axlePositions = staticLoad.axlePositions.length >= 2
      ? staticLoad.axlePositions
      : [plan.vehicleLength * 0.70, plan.vehicleLength * 0.90]
    const automaticAxleModel = sortedPlanAxles.length < 2 || sortedPlanAxles.some(a => a.source === 'AUTO')
    const cgWeight = staticLoad.totalWeight
    const cgX = staticLoad.cgX
    const cgY = staticLoad.cgY
    const axleLoads = !automaticAxleModel && staticLoad.valid ? staticLoad.axleLoads : []
    const axleLoadsValid = axleLoads.length === axlePositions.length && axleLoads.every(load => Number.isFinite(load) && load >= 0)
    const cgBetweenAxles = staticLoad.valid
    const transverseShift = Math.abs(cgY - plan.vehicleWidth / 2) / plan.vehicleWidth
    const transverseImbalance = transverseShift > 0.25
    const axleValue = axleLoadsValid
      ? axleLoads.map((load, i) => {
          const semanticNumber = axlePositions.length === 2 ? (i === axlePositions.length - 1 ? 1 : 2) : i + 1
          const role = axlePositions.length === 2 ? (semanticNumber === 1 ? ' передняя' : ' задняя') : ''
          return 'Ось ' + semanticNumber + role + ': ' + new Intl.NumberFormat('ru-RU').format(Math.round(load)) + ' кг'
        }).join(' · ')
      : (staticLoad.reason ?? 'Недостаточно данных для расчёта')
    const axleCapacitiesKnown = plan.axles.length >= 2 && plan.axles.every(a => a.capacityKg > 0)
    const sortedAxles = plan.axles.slice().sort((a, b) => a.position - b.position)
    const axleCapacityViolation = axleCapacitiesKnown && axleLoadsValid && axleLoads.some((load, i) => load > sortedAxles[i].capacityKg)
    const cgValue = cgWeight > 0
      ? 'X ' + (cgX / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м · Y ' + (cgY / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м'
      : '—'
    const bodyHeightViolation = hasHeightData && maxCargoHeight > plan.vehicleHeight
    const localHeightViolation = plan.pallets.some(p =>
      p.height > 0 &&
      plan.obstacles.some(o =>
        (o.height ?? 0) > 0 &&
        p.height > plan.vehicleHeight - (o.height ?? 0) &&
        p.x < o.x + o.length && p.x + p.length > o.x &&
        p.y < o.y + o.width && p.y + p.width > o.y
      )
    )
    const heightViolation = bodyHeightViolation || localHeightViolation
    const localClearance = plan.vehicleHeight - Math.max(0, ...plan.obstacles.map(o => o.height ?? 0))
    const heightValue = hasHeightData
      ? localHeightViolation
        ? 'Под препятствием: доступно ' + (localClearance / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м · груз ' + (maxCargoHeight / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м'
        : (maxCargoHeight / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м / ' + (plan.vehicleHeight / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м'
      : '—'
    return [
      { id: 'count', label: 'Размещение', value: `${plan.pallets.length} / ${requestedCount}`, status: placementViolation ? 'VIOLATION' : 'CHECKED', note: geometryViolation ? 'Есть выход за кузов, пересечение или недоступную зону' : unplacedCount > 0 ? `Не размещено: ${unplacedCount} шт. Недостаточно свободного места` : 'Все паллеты внутри кузова и не пересекаются' },
      { id: 'weight', label: 'Вес груза', value: unplacedCount > 0 ? `${new Intl.NumberFormat('ru-RU').format(totalWeight)} / ${new Intl.NumberFormat('ru-RU').format(requestedWeight)} кг` : `${new Intl.NumberFormat('ru-RU').format(totalWeight)} кг`, status: 'CHECKED', note: unplacedCount > 0 ? `Размещено ${new Intl.NumberFormat('ru-RU').format(totalWeight)} кг из ${new Intl.NumberFormat('ru-RU').format(requestedWeight)} кг` : 'Сумма введённых весов' },
      { id: 'axles', label: 'Нагрузка на оси', value: axleValue, status: automaticAxleModel ? 'NOT_CHECKED' : (axleCapacityViolation || !cgBetweenAxles || transverseImbalance ? 'VIOLATION' : axleLoadsValid ? 'CALCULATED' : 'NOT_CHECKED'), note: automaticAxleModel ? 'Положение осей задано автоматически и служит только ориентиром. Перетащите ось или задайте координаты вручную для расчёта.' : axleCapacityViolation ? 'Расчётная нагрузка превышает допустимую нагрузку одной из осей' : !cgBetweenAxles ? 'Центр массы находится вне базы осей — есть риск разгрузки крайней оси' : axleLoadsValid ? (
          transverseImbalance
            ? '⚠ Центр массы заметно смещён поперёк кузова — оцените распределение по бортам'
            : axlePositions.length > 2
              ? 'Упрощённая статическая модель: нагрузка распределена между двумя осями, охватывающими центр массы'
              : (axleCapacitiesKnown ? 'Статический расчёт по введённым положениям и допустимым нагрузкам осей' : 'Статический расчёт по введённым положениям осей; допустимая нагрузка не указана')
        ) : (staticLoad.reason ?? 'Недостаточно данных для расчёта') },
      { id: 'height', label: 'Высота', value: heightValue, status: heightViolation ? 'VIOLATION' : hasHeightData ? 'CHECKED' : 'NOT_CHECKED', note: bodyHeightViolation ? 'Груз выше полезной высоты кузова' : localHeightViolation ? 'В зоне холодильной установки полезная высота уменьшена на ' + (Math.max(0, ...plan.obstacles.map(o => o.height ?? 0)) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м' : hasHeightData ? 'Высота груза не превышает высоту кузова на всей доступной площади' : 'Нет данных для расчёта' },
      { id: 'payload', label: 'Грузоподъёмность', value: plan.payloadCapacityKg != null ? `${new Intl.NumberFormat('ru-RU').format(totalWeight)} / ${new Intl.NumberFormat('ru-RU').format(plan.payloadCapacityKg)} кг` : '—', status: plan.payloadCapacityKg != null ? (totalWeight > plan.payloadCapacityKg ? 'VIOLATION' : 'CHECKED') : 'NOT_CHECKED', note: plan.payloadCapacityKg != null ? (totalWeight > plan.payloadCapacityKg ? 'Размещённый груз превышает грузоподъёмность' : `Размещённый груз в пределах ${new Intl.NumberFormat('ru-RU').format(plan.payloadCapacityKg)} кг`) : 'Не указана грузоподъёмность' },
      { id: 'cg', label: 'Центр тяжести', value: cgValue, status: cgWeight > 0 ? 'CALCULATED' : 'NOT_CHECKED', note: cgWeight > 0 ? 'Расчётный центр массы размещённого груза' : 'Нет размещённого груза' },
      { id: 'area', label: 'Занятая площадь', value: `${occupied.toFixed(1)} м²`, status: 'CHECKED', note: 'Площадь паллет' },
    ]
  },
}