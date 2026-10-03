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

    const step = 50
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

    const snap = (value: number) => Math.max(0, Math.round(value / step) * step)

    const verticalClear = (candidate: { x: number; y: number; length: number; width: number; height: number }) => {
      if (candidate.height <= 0) return true
      if (candidate.height > plan.vehicleHeight) return false
      return !verticalZones.some(zone => {
        const overlap =
          candidate.x < zone.x + zone.length &&
          candidate.x + candidate.length > zone.x &&
          candidate.y < zone.y + zone.width &&
          candidate.y + candidate.width > zone.y
        return !overlap || candidate.height <= plan.vehicleHeight - (zone.height ?? 0)
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
        const byHeight = b.group.height - a.group.height
        if (byHeight !== 0) return byHeight
        return b.group.weight - a.group.weight
      })

    if (items.length === 0) return [{ ...plan, pallets: [] }]

    type Item = typeof items[number]

    const orientations = (group: Item['group']): Array<[number, number]> => {
      const result: Array<[number, number]> = [[group.length, group.width]]
      if (group.rotatable && group.length !== group.width) result.push([group.width, group.length])
      return result
    }

    const makeCandidate = (
      item: Item,
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
        x: snap(x),
        y: snap(y),
        rotatable: item.group.rotatable,
        stackable: false,
      }
      return canPlace(candidate, placed) ? candidate : null
    }

    const candidatePositions = (
      item: Item,
      length: number,
      width: number,
      placed: Pallet[],
    ) => {
      const xSet = new Set<number>([
        0,
        plan.vehicleLength - length,
        (plan.vehicleLength - length) / 2,
      ])
      const ySet = new Set<number>([
        0,
        plan.vehicleWidth - width,
        (plan.vehicleWidth - width) / 2,
      ])

      for (const zone of [...blocked, ...placed]) {
        xSet.add(zone.x - length)
        xSet.add(zone.x + zone.length)
        ySet.add(zone.y - width)
        ySet.add(zone.y + zone.width)
      }

      return {
        xs: [...xSet].map(snap).filter(x => x >= 0 && x + length <= plan.vehicleLength),
        ys: [...ySet].map(snap).filter(y => y >= 0 && y + width <= plan.vehicleWidth),
      }
    }

    const fillRow = (
      item: Item,
      length: number,
      width: number,
      y: number,
      placed: Pallet[],
    ) => {
      const result: Pallet[] = []
      const rowPlaced = placed.slice()
      const maxScan = Math.max(0, Math.floor(plan.vehicleLength / step))

      for (let xi = 0; xi <= maxScan; xi += 1) {
        const x = xi * step
        const candidate = makeCandidate(item, length, width, x, y, rowPlaced)
        if (!candidate) continue
        candidate.id = rowPlaced.length + 1
        rowPlaced.push(candidate)
        result.push(candidate)
      }

      return result
    }

    const homogeneous = items.every(item =>
      item.group.length === items[0].group.length &&
      item.group.width === items[0].group.width &&
      item.group.height === items[0].group.height &&
      item.group.weight === items[0].group.weight &&
      item.group.rotatable === items[0].group.rotatable,
    )

    const structured: Pallet[][] = []

    if (homogeneous) {
      const group = items[0].group
      const pairs = orientations(group)
      const maxRows = Math.min(4, Math.floor(plan.vehicleWidth / Math.min(...pairs.map(pair => pair[1]))))

      for (let rowCount = 1; rowCount <= maxRows; rowCount += 1) {
        const patterns: Array<Array<[number, number]>> = []
        const buildPatterns = (index: number, current: Array<[number, number]>) => {
          if (index === rowCount) {
            patterns.push(current.slice())
            return
          }
          for (const pair of pairs) {
            current.push(pair)
            buildPatterns(index + 1, current)
            current.pop()
          }
        }
        buildPatterns(0, [])

        for (const pattern of patterns.slice(0, 16)) {
          const totalWidth = pattern.reduce((sum, pair) => sum + pair[1], 0)
          if (totalWidth > plan.vehicleWidth + 0.001) continue

          for (const align of [0, 1, 2]) {
            let cursorY = align === 0
              ? 0
              : align === 1
                ? Math.max(0, plan.vehicleWidth - totalWidth)
                : Math.max(0, (plan.vehicleWidth - totalWidth) / 2)

            let placed: Pallet[] = []
            let itemIndex = 0

            for (const [length, width] of pattern) {
              const remaining = items.length - itemIndex
              const item = items[Math.min(itemIndex, items.length - 1)]
              const rowCandidates = fillRow(item, length, width, cursorY, placed)
              for (const next of rowCandidates.slice(0, remaining)) {
                placed.push({ ...next, id: placed.length + 1 })
                itemIndex += 1
              }

              cursorY += width
            }

            if (placed.length > 0) structured.push(placed)
          }
        }
      }
    }

    const score = (pallets: Pallet[]) => {
      if (pallets.length === 0) return Number.NEGATIVE_INFINITY
      const totalWeight = pallets.reduce((sum, pallet) => sum + pallet.weight, 0)
      const cgX = totalWeight > 0
        ? pallets.reduce((sum, pallet) => sum + pallet.weight * (pallet.x + pallet.length / 2), 0) / totalWeight
        : plan.vehicleLength / 2
      const cgY = totalWeight > 0
        ? pallets.reduce((sum, pallet) => sum + pallet.weight * (pallet.y + pallet.width / 2), 0) / totalWeight
        : plan.vehicleWidth / 2
      const axlePositions = plan.axles.slice().sort((a, b) => a.position - b.position).map(axle => axle.position)
      const axleCenter = axlePositions.length >= 2
        ? (axlePositions[0] + axlePositions[axlePositions.length - 1]) / 2
        : plan.vehicleLength / 2
      const transversePenalty = Math.abs(cgY - plan.vehicleWidth / 2) / Math.max(1, plan.vehicleWidth)
      const longitudinalPenalty = Math.abs(cgX - axleCenter) / Math.max(1, plan.vehicleLength)
      let contact = 0
      pallets.forEach(pallet => {
        for (const other of [...blocked, ...pallets]) {
          if (other === pallet) continue
          const touchX =
            (pallet.x + pallet.length === other.x || pallet.x === other.x + other.length) &&
            pallet.y < other.y + other.width &&
            pallet.y + pallet.width > other.y
          const touchY =
            (pallet.y + pallet.width === other.y || pallet.y === other.y + other.width) &&
            pallet.x < other.x + other.length &&
            pallet.x + pallet.length > other.x
          if (touchX || touchY) contact += 1
        }
      })
      return pallets.length * 10000 + contact * 20 - transversePenalty * 100 - longitudinalPenalty * 40
    }

    const generic = (reverseX: boolean, reverseY: boolean): Pallet[] => {
      const placed: Pallet[] = []
      for (const item of items) {
        let best: Pallet | null = null
        let bestScore = Number.NEGATIVE_INFINITY
        for (const [length, width] of orientations(item.group)) {
          const { xs, ys } = candidatePositions(item, length, width, placed)
          const orderedXs = xs.sort((a, b) => reverseX ? b - a : a - b)
          const orderedYs = ys.sort((a, b) => {
            const ac = Math.abs(a + width / 2 - plan.vehicleWidth / 2)
            const bc = Math.abs(b + width / 2 - plan.vehicleWidth / 2)
            return reverseY ? bc - ac : ac - bc
          })
          for (const x of orderedXs) {
            for (const y of orderedYs) {
              const candidate = makeCandidate(item, length, width, x, y, placed)
              if (!candidate) continue
              const candidateScore =
                (x + length / 2) * (reverseX ? -1 : 1) +
                Math.abs(y + width / 2 - plan.vehicleWidth / 2) * -2
              if (candidateScore > bestScore) {
                best = candidate
                bestScore = candidateScore
              }
            }
          }
        }
        if (best) placed.push(best)
      }
      return placed
    }

    const candidates = [
      ...structured,
      generic(false, false),
      generic(true, false),
      generic(false, true),
      generic(true, true),
    ].filter(variant => variant.length > 0)

    const maxPlaced = Math.max(...candidates.map(variant => variant.length), 0)
    const unique = new Map<string, Pallet[]>()
    const makeSignature = (pallets: Pallet[]) =>
      pallets.map(p => [p.x, p.y, p.length, p.width].join(':')).sort().join('|')

    for (const variant of candidates) {
      if (variant.length !== maxPlaced) continue
      const normalized = variant.map((p, index) => ({ ...p, id: index + 1 }))
      unique.set(makeSignature(normalized), normalized)
    }

    const selected = [...unique.values()].sort((a, b) => score(b) - score(a)).slice(0, 3)

    return selected.map(pallets => ({
      ...plan,
      pallets,
    }))
  },
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
    const cargoHeights = plan.cargoGroups.map(group => group.height)
    const maxCargoHeight = Math.max(0, ...cargoHeights)
    const hasHeightData = plan.vehicleHeight > 0 && cargoHeights.length > 0 && cargoHeights.every(height => height > 0)

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
      : 'Укажите высоту каждой грузовой группы'
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
      { id: 'height', label: 'Высота', value: heightValue, status: heightViolation ? 'VIOLATION' : hasHeightData ? 'CHECKED' : 'NOT_CHECKED', note: bodyHeightViolation ? 'Груз выше полезной высоты кузова' : localHeightViolation ? 'В зоне холодильной установки полезная высота уменьшена на ' + (Math.max(0, ...plan.obstacles.map(o => o.height ?? 0)) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м' : hasHeightData ? 'Высота груза не превышает высоту кузова на всей доступной площади' : 'Не указана высота груза хотя бы в одной грузовой группе' },
      { id: 'payload', label: 'Грузоподъёмность', value: plan.payloadCapacityKg != null ? `${new Intl.NumberFormat('ru-RU').format(requestedWeight + fixedWeight)} / ${new Intl.NumberFormat('ru-RU').format(plan.payloadCapacityKg)} кг` : '—', status: plan.payloadCapacityKg != null ? ((requestedWeight + fixedWeight) > plan.payloadCapacityKg ? 'VIOLATION' : 'CHECKED') : 'NOT_CHECKED', note: plan.payloadCapacityKg != null ? ((requestedWeight + fixedWeight) > plan.payloadCapacityKg ? 'Полная масса указанного заказа превышает грузоподъёмность' : 'Полная масса указанного заказа укладывается в грузоподъёмность') : 'Не указана грузоподъёмность' },
      { id: 'cg', label: 'Центр тяжести', value: cgValue, status: cgWeight > 0 ? 'CALCULATED' : 'NOT_CHECKED', note: cgWeight > 0 ? 'Расчётный центр массы размещённого груза' : 'Нет размещённого груза' },
      { id: 'area', label: 'Занятая площадь', value: `${occupied.toFixed(1)} м²`, status: 'CHECKED', note: 'Площадь паллет' },
    ]
  },
}