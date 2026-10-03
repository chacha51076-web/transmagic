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

    const overlaps = (
      a: { x: number; y: number; length: number; width: number },
      b: { x: number; y: number; length: number; width: number },
    ) =>
      a.x < b.x + b.length &&
      a.x + a.length > b.x &&
      a.y < b.y + b.width &&
      a.y + a.width > b.y

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

    const canPlace = (candidate: Pallet, placed: Pallet[]) =>
      candidate.x >= 0 &&
      candidate.y >= 0 &&
      candidate.x + candidate.length <= plan.vehicleLength &&
      candidate.y + candidate.width <= plan.vehicleWidth &&
      verticalClear(candidate) &&
      !blocked.some(zone => overlaps(candidate, zone)) &&
      !placed.some(item => overlaps(candidate, item))

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

    const orientationPairs = (group: typeof items[number]['group'], reverse = false) => {
      const normal: Array<[number, number]> = [[group.length, group.width]]
      if (group.rotatable && group.length !== group.width) normal.push([group.width, group.length])
      return reverse ? normal.reverse() : normal
    }

    const makeCandidate = (
      item: typeof items[number],
      length: number,
      width: number,
      x: number,
      y: number,
      placed: Pallet[],
    ): Pallet | null => {
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
      return canPlace(candidate, placed) ? candidate : null
    }

    const shelfLevels = (placed: Pallet[]) => {
      const levels = new Set<number>([0, Math.max(0, plan.vehicleWidth - 50)])
      for (const item of placed) {
        levels.add(item.y)
        levels.add(item.y + item.width)
      }
      // A 50 mm scan closes small packing gaps that can otherwise leave
      // the solver with a poor partial solution.
      for (let y = 0; y <= plan.vehicleWidth; y += 50) levels.add(y)
      return [...levels]
        .filter(y => y >= 0 && y < plan.vehicleWidth)
        .sort((a, b) => a - b)
    }

    const columnLevels = (placed: Pallet[]) => {
      const levels = new Set<number>([0, Math.max(0, plan.vehicleLength - 50)])
      for (const item of placed) {
        levels.add(item.x)
        levels.add(item.x + item.length)
      }
      for (let x = 0; x <= plan.vehicleLength; x += 50) levels.add(x)
      return [...levels]
        .filter(x => x >= 0 && x < plan.vehicleLength)
        .sort((a, b) => a - b)
    }

    const buildShelf = (reverseRows: boolean, reverseOrientation: boolean) => {
      const placed: Pallet[] = []

      for (const item of items) {
        let best: Pallet | null = null
        let bestMetric = Number.POSITIVE_INFINITY

        for (const [length, width] of orientationPairs(item.group, reverseOrientation)) {
          const ys = shelfLevels(placed)
          if (reverseRows) ys.reverse()

          // Prefer a compact set of shelves that actually maximizes
          // the number of rows across the body. A single centered shelf can
          // leave too little room above and below it, which would miss valid
          // layouts such as 2 x 5 EUR pallets in a 2.05 m body.
          const rowCount = Math.max(1, Math.floor((plan.vehicleWidth + 0.001) / width))
          const rowStart = Math.max(0, (plan.vehicleWidth - rowCount * width) / 2)
          const preferredYs = Array.from(
            { length: rowCount },
            (_, index) => rowStart + index * width,
          )

          const preferredSet = new Set(preferredYs.map(value => value.toFixed(3)))
          const fallbackYs = ys.filter(value => !preferredSet.has(value.toFixed(3)))
          const orderedYs = reverseRows
            ? [...preferredYs.slice().reverse(), ...fallbackYs.reverse()]
            : [...preferredYs, ...fallbackYs]

          for (const y of orderedYs) {
            if (y + width > plan.vehicleWidth) continue

            // Search from the rear doors forward. At each shelf we choose
            // the leftmost feasible placement; this maximizes the number
            // of pallets before any longitudinal balance optimization.
            for (let x = 0; x + length <= plan.vehicleLength; x += 50) {
              const candidate = makeCandidate(item, length, width, x, y, placed)
              if (!candidate) continue

              const metric = y * 100000 + x
              if (metric < bestMetric) {
                best = candidate
                bestMetric = metric
              }

              // For each row, the first valid x is the preferred one.
              break
            }

            if (best) break
          }
          if (best) break
        }

        if (best) placed.push(best)
      }

      return placed
    }

    const buildColumns = (reverseColumns: boolean, reverseOrientation: boolean) => {
      const placed: Pallet[] = []

      for (const item of items) {
        let best: Pallet | null = null
        let bestMetric = Number.POSITIVE_INFINITY

        for (const [length, width] of orientationPairs(item.group, reverseOrientation)) {
          const xs = columnLevels(placed)
          if (reverseColumns) xs.reverse()

          for (const x of xs) {
            if (x + length > plan.vehicleLength) continue

            const targetY = Math.max(0, (plan.vehicleWidth - width) / 2)
            const ys = []
            for (let y = 0; y + width <= plan.vehicleWidth; y += 50) ys.push(y)
            ys.sort((a, b) => {
              const da = Math.abs(a - targetY)
              const db = Math.abs(b - targetY)
              if (da !== db) return da - db
              return a - b
            })

            for (const y of ys) {
              const candidate = makeCandidate(item, length, width, x, y, placed)
              if (!candidate) continue
              const metric = x * 100000 + y
              if (metric < bestMetric) {
                best = candidate
                bestMetric = metric
              }
              break
            }
            if (best) break
          }
          if (best) break
        }

        if (best) placed.push(best)
      }

      return placed
    }

    // For homogeneous pallet groups, explicitly test mixed-orientation rows.
    // This is important for Euro pallets in a ~2 m body: one 800 mm row plus
    // one 1200 mm rotated row can use the width much better than two identical rows.
    const firstGroup = items[0]?.group
    const homogeneous = Boolean(firstGroup) && items.every(
      item =>
        item.group.length === firstGroup?.length &&
        item.group.width === firstGroup?.width &&
        item.group.height === firstGroup?.height,
    )

    const buildRowPattern = (pattern: Array<'normal' | 'rotated'>) => {
      if (!homogeneous || !firstGroup) return []

      const rows = pattern.map(mode => {
        const [length, width] =
          mode === 'rotated' && firstGroup.rotatable && firstGroup.length !== firstGroup.width
            ? [firstGroup.width, firstGroup.length]
            : [firstGroup.length, firstGroup.width]
        return { mode, length, width, y: 0 }
      })

      const totalWidth = rows.reduce((sum, row) => sum + row.width, 0)
      if (totalWidth > plan.vehicleWidth + 0.001) return []

      const startY = Math.max(0, (plan.vehicleWidth - totalWidth) / 2)
      let cursorY = startY
      for (const row of rows) {
        row.y = cursorY
        cursorY += row.width
      }

      const placed: Pallet[] = []
      for (const item of items) {
        let placedThisItem = false

        for (const row of rows) {
          const rotated = row.mode === 'rotated' && item.group.rotatable && item.group.length !== item.group.width
          const length = rotated ? item.group.width : item.group.length
          const width = rotated ? item.group.length : item.group.width

          for (let x = 0; x + length <= plan.vehicleLength; x += 50) {
            const candidate = makeCandidate(item, length, width, x, row.y, placed)
            if (!candidate) continue
            placed.push(candidate)
            placedThisItem = true
            break
          }

          if (placedThisItem) break
        }
      }

      return placed
    }

    const variants = [
      ...(homogeneous
        ? [
            buildRowPattern(['normal', 'rotated']),
            buildRowPattern(['rotated', 'normal']),
            buildRowPattern(['normal', 'normal']),
            buildRowPattern(['rotated', 'rotated']),
          ]
        : []),
      buildShelf(false, false),
      buildShelf(true, false),
      buildColumns(false, true),
      buildColumns(true, false),
    ]

    // The requested quantity is a hard requirement for the planner.
    // We never prefer a prettier partial plan over a plan that fits more
    // of the requested cargo. First maximize count, then keep distinct
    // layouts among those maximum-count results.
    const maxPlaced = Math.max(...variants.map(variant => variant.length), 0)
    const unique = new Map<string, Pallet[]>()

    for (const pallets of variants.filter(variant => variant.length === maxPlaced)) {
      const normalized = pallets.map((p, index) => ({ ...p, id: index + 1 }))
      const signature = normalized
        .map(p => [p.length, p.width, p.x, p.y].join(':'))
        .sort()
        .join('|')
      if (!unique.has(signature)) unique.set(signature, normalized)
    }

    return [...unique.values()].slice(0, 3).map(pallets => ({
      ...plan,
      pallets,
    }))
  }
}

export interface VehicleFitSuggestion {
  currentLength: number
  currentWidth: number
  lengthAtCurrentWidth: number | null
  widthAtCurrentLength: number | null
  minimumHeight: number | null
  note: string
}

export const findMinimumVehicleSize = (plan: LoadPlan): VehicleFitSuggestion | null => {
  const requested = plan.cargoGroups.reduce((sum, group) => sum + group.count, 0)
  const currentPlaced = plan.pallets.length
  if (currentPlaced >= requested) return null

  const maxCargoLength = Math.max(...plan.cargoGroups.map(group => Math.max(group.length, group.width)))
  const maxCargoWidth = Math.max(...plan.cargoGroups.map(group => Math.min(group.length, group.width)))

  const quickFit = (vehicleLength: number, vehicleWidth: number) => {
    const candidatePlan: LoadPlan = {
      ...plan,
      vehicleLength,
      vehicleWidth,
      pallets: [],
    }
    const variants = PlacementService.createVariants(candidatePlan)
    return Math.max(0, ...variants.map(variant => variant.pallets.length)) >= requested
  }

  // We give the recommendation as an engineering estimate: search in 100 mm
  // increments, then add a clear note that the result is based on the same
  // geometric rules as the planner.
  let lengthAtCurrentWidth: number | null = null
  const maxLength = Math.max(plan.vehicleLength + 5000, maxCargoLength + 1000)
  for (let length = Math.max(1000, Math.ceil(maxCargoLength / 100) * 100); length <= maxLength; length += 100) {
    if (quickFit(length, plan.vehicleWidth)) {
      lengthAtCurrentWidth = length
      break
    }
  }

  let widthAtCurrentLength: number | null = null
  const maxWidth = Math.max(plan.vehicleWidth + 2000, maxCargoWidth + 1000)
  for (let width = Math.max(1000, Math.ceil(maxCargoWidth / 100) * 100); width <= maxWidth; width += 100) {
    if (quickFit(plan.vehicleLength, width)) {
      widthAtCurrentLength = width
      break
    }
  }

  const minimumHeight = Math.max(...plan.cargoGroups.map(group => group.height), 0)
  const heightProblem = minimumHeight > plan.vehicleHeight

  return {
    currentLength: plan.vehicleLength,
    currentWidth: plan.vehicleWidth,
    lengthAtCurrentWidth: heightProblem ? null : lengthAtCurrentWidth,
    widthAtCurrentLength: heightProblem ? null : widthAtCurrentLength,
    minimumHeight: heightProblem ? minimumHeight : null,
    note: heightProblem
      ? 'Увеличение длины или ширины не решит проблему: часть груза выше полезной высоты кузова.'
      : 'Ориентировочная минимальная геометрия. Поиск идёт с шагом 100 мм и использует те же ограничения размещения, что и планировщик.',
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