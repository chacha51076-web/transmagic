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
  async createVariants(plan: LoadPlan): Promise<LoadPlan[]> {
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

    const canPlace = (candidate: Pallet, placed: Pallet[]) => {
      if (candidate.x < -0.001 || candidate.y < -0.001) return false
      if (candidate.x + candidate.length > plan.vehicleLength + 0.001) return false
      if (candidate.y + candidate.width > plan.vehicleWidth + 0.001) return false
      if (candidate.height > plan.vehicleHeight + 0.001) return false

      const verticalConflict = verticalZones.some(zone => {
        const footprintOverlap =
          candidate.x < zone.x + zone.length - 0.001 &&
          candidate.x + candidate.length > zone.x + 0.001 &&
          candidate.y < zone.y + zone.width - 0.001 &&
          candidate.y + candidate.width > zone.y + 0.001
        return footprintOverlap && candidate.height > plan.vehicleHeight - (zone.height ?? 0) + 0.001
      })
      if (verticalConflict) return false

      if (blocked.some(zone => overlaps(candidate, zone))) return false
      return !placed.some(item => overlaps(candidate, item))
    }

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

    const orientationPairs = (group: Item['group']): Array<[number, number]> => {
      const result: Array<[number, number]> = [[group.length, group.width]]
      if (group.rotatable && group.length !== group.width) {
        result.push([group.width, group.length])
      }
      return result
    }

    const coordinateKey = (value: number) => value.toFixed(4)

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
        x,
        y,
        rotatable: item.group.rotatable,
        stackable: false,
      }
      return canPlace(candidate, placed) ? candidate : null
    }

    // Для ортогональной упаковки достаточно проверять канонические
    // координаты, образованные границами кузова, препятствий и уже
    // размещённых прямоугольников. Между такими координатами груз можно
    // сдвинуть, не создавая нового принципиально отличного варианта.
    const candidatePositions = (
      length: number,
      width: number,
      placed: Pallet[],
    ) => {
      const xValues = new Map<string, number>()
      const yValues = new Map<string, number>()

      const addX = (value: number) => {
        if (value >= -0.001 && value <= plan.vehicleLength - length + 0.001) {
          const safe = Math.max(0, Math.min(plan.vehicleLength - length, value))
          xValues.set(coordinateKey(safe), safe)
        }
      }
      const addY = (value: number) => {
        if (value >= -0.001 && value <= plan.vehicleWidth - width + 0.001) {
          const safe = Math.max(0, Math.min(plan.vehicleWidth - width, value))
          yValues.set(coordinateKey(safe), safe)
        }
      }

      addX(0)
      addX(plan.vehicleLength - length)
      addY(0)
      addY(plan.vehicleWidth - width)

      for (const zone of [...blocked, ...placed]) {
        addX(zone.x)
        addX(zone.x + zone.length)
        addX(zone.x - length)
        addX(zone.x + zone.length - length)

        addY(zone.y)
        addY(zone.y + zone.width)
        addY(zone.y - width)
        addY(zone.y + zone.width - width)
      }

      return {
        xs: [...xValues.values()],
        ys: [...yValues.values()],
      }
    }

    const placementScore = (candidate: Pallet, placed: Pallet[]) => {
      const bodyCenterX = plan.vehicleLength / 2
      const bodyCenterY = plan.vehicleWidth / 2
      const centerX = candidate.x + candidate.length / 2
      const centerY = candidate.y + candidate.width / 2

      const centerPenalty =
        Math.abs(centerX - bodyCenterX) / Math.max(1, plan.vehicleLength) +
        Math.abs(centerY - bodyCenterY) / Math.max(1, plan.vehicleWidth)

      let contacts = 0
      for (const other of [...blocked, ...placed]) {
        const touchX =
          (Math.abs(candidate.x + candidate.length - other.x) < 0.001 ||
            Math.abs(candidate.x - (other.x + other.length)) < 0.001) &&
          candidate.y < other.y + other.width &&
          candidate.y + candidate.width > other.y

        const touchY =
          (Math.abs(candidate.y + candidate.width - other.y) < 0.001 ||
            Math.abs(candidate.y - (other.y + other.width)) < 0.001) &&
          candidate.x < other.x + other.length &&
          candidate.x + candidate.length > other.x

        if (touchX || touchY) contacts += 1
      }

      return contacts * 20 - centerPenalty * 100
    }

    const signature = (pallets: Pallet[]) =>
      pallets
        .map(p => [p.x, p.y, p.length, p.width, p.height, p.weight].join(':'))
        .sort()
        .join('|')

    const diversityDistance = (a: Pallet[], b: Pallet[]) => {
      const left = new Set(signature(a).split('|'))
      const right = new Set(signature(b).split('|'))
      let difference = 0
      for (const value of left) if (!right.has(value)) difference += 1
      for (const value of right) if (!left.has(value)) difference += 1
      return difference
    }

    const cargoArea = items.reduce((sum, item) => sum + item.group.length * item.group.width, 0)
    if (cargoArea > plan.vehicleLength * plan.vehicleWidth + 0.001) {
      const partial = [{
        ...plan,
        pallets: [],
      }]
      return partial
    }

    let bestCount = 0
    let bestLayouts: Pallet[][] = []
    let nodes = 0
    let stopAfterEnoughFullLayouts = false
    const visited = new Set<string>()

    const recordLayout = (pallets: Pallet[]) => {
      const normalized = pallets.map((pallet, index) => ({ ...pallet, id: index + 1 }))
      const sig = signature(normalized)

      if (normalized.length > bestCount) {
        bestCount = normalized.length
        bestLayouts = [normalized]
      } else if (normalized.length === bestCount && !bestLayouts.some(layout => signature(layout) === sig)) {
        bestLayouts.push(normalized)
        if (bestLayouts.length > 12) {
          bestLayouts.sort((a, b) => {
            if (a.length !== b.length) return b.length - a.length
            return signature(a).localeCompare(signature(b))
          })
          bestLayouts = bestLayouts.slice(0, 12)
        }
      }

      if (bestCount === items.length && bestLayouts.length >= 6) {
        stopAfterEnoughFullLayouts = true
      }
    }

    const search = async (index: number, placed: Pallet[]): Promise<void> => {
      if (stopAfterEnoughFullLayouts) return

      nodes += 1
      if (nodes % 250 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }

      const remaining = items.length - index
      if (placed.length + remaining < bestCount) return

      if (index >= items.length) {
        recordLayout(placed)
        return
      }

      const stateKey = index + '|' + signature(placed)
      if (visited.has(stateKey)) return
      visited.add(stateKey)

      const item = items[index]
      const branches: Array<{ pallet: Pallet; score: number }> = []

      for (const [length, width] of orientationPairs(item.group)) {
        const { xs, ys } = candidatePositions(length, width, placed)
        for (const x of xs) {
          for (const y of ys) {
            const candidate = makeCandidate(item, length, width, x, y, placed)
            if (!candidate) continue
            branches.push({
              pallet: candidate,
              score: placementScore(candidate, placed),
            })
          }
        }
      }

      branches.sort((a, b) => b.score - a.score)

      // Важно: это не beam-search. Мы не выбрасываем слабые ветви —
      // каждая допустимая каноническая позиция будет проверена.
      const branchKeys = new Set<string>()
      for (const branch of branches) {
        const branchKey = [branch.pallet.x, branch.pallet.y, branch.pallet.length, branch.pallet.width].join(':')
        if (branchKeys.has(branchKey)) continue
        branchKeys.add(branchKey)

        await search(index + 1, [...placed, branch.pallet])
        if (stopAfterEnoughFullLayouts) return
      }

      // Пропустить текущую единицу груза разрешаем только для поиска
      // максимального частичного размещения. Если весь заказ существует,
      // search остановится на полном решении и этот путь не понадобится.
      await search(index + 1, placed)
    }

    await search(0, [])

    if (bestLayouts.length === 0) bestLayouts = [[]]

    const selected: Pallet[][] = []
    for (const layout of [...bestLayouts].sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length
      return signature(a).localeCompare(signature(b))
    })) {
      if (
        selected.length === 0 ||
        selected.every(other => diversityDistance(other, layout) >= Math.max(2, Math.ceil(bestCount * 0.15)))
      ) {
        selected.push(layout)
      }
      if (selected.length >= 3) break
    }

    if (selected.length < 3) {
      for (const layout of bestLayouts) {
        if (!selected.some(other => signature(other) === signature(layout))) {
          selected.push(layout)
        }
        if (selected.length >= 3) break
      }
    }

    return selected.map(layout => ({
      ...plan,
      pallets: layout.map((pallet, index) => ({ ...pallet, id: index + 1 })),
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

export const findMinimumVehicleSize = async (plan: LoadPlan): Promise<VehicleFitSuggestion | null> => {
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
    const variants = await PlacementService.createVariants(candidatePlan)
    return Math.max(0, ...variants.map(variant => variant.pallets.length)) >= requested
  }

  // We give the recommendation as an engineering estimate: search in 100 mm
  // increments, then add a clear note that the result is based on the same
  // geometric rules as the planner.
  let lengthAtCurrentWidth: number | null = null
  const maxLength = Math.max(plan.vehicleLength + 5000, maxCargoLength + 1000)
  for (let length = Math.max(1000, Math.ceil(maxCargoLength / 100) * 100); length <= maxLength; length += 100) {
    if (await quickFit(length, plan.vehicleWidth)) {
      lengthAtCurrentWidth = length
      break
    }
  }

  let widthAtCurrentLength: number | null = null
  const maxWidth = Math.max(plan.vehicleWidth + 2000, maxCargoWidth + 1000)
  for (let width = Math.max(1000, Math.ceil(maxCargoWidth / 100) * 100); width <= maxWidth; width += 100) {
    if (await quickFit(plan.vehicleLength, width)) {
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