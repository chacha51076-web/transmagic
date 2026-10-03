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
      gaps: [], obstacles: [{ id: 'cooler', x: 5320, y: 410, length: 680, width: 1230, label: 'Холодильная установка' }],
      unavailableZones: [], axles: [],
      cargoGroups: [{ id: 'eur', name: 'EUR паллета', length: 1200, width: 800, height: 0, weight: 450, count: 10, rotatable: true, stackable: false }],
      pallets,
    }
  },
}

export type PlacementVariant = 'BALANCED' | 'REAR' | 'AXLE'

export const PlacementService = {
  createVariants(plan: LoadPlan): LoadPlan[] {
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const overlaps = (a: {x:number;y:number;length:number;width:number}, b: {x:number;y:number;length:number;width:number}) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y

    const variants: LoadPlan[] = []
    const fixedObstacles = plan.obstacles.filter(o => (o.weight ?? 0) > 0)
    const fixedWeight = fixedObstacles.reduce((sum, o) => sum + (o.weight ?? 0), 0)
    const fixedMomentX = fixedObstacles.reduce((sum, o) => sum + (o.weight ?? 0) * (o.x + o.length / 2), 0)
    const fixedMomentY = fixedObstacles.reduce((sum, o) => sum + (o.weight ?? 0) * (o.y + o.width / 2), 0)
    const axlePositions = plan.axles.length >= 2
      ? plan.axles.slice().sort((a,b) => a.position-b.position).map(a => a.position)
      : [plan.vehicleLength * .70, plan.vehicleLength * .90]
    const targetX = (axlePositions[0] + axlePositions[axlePositions.length - 1]) / 2
    const targetY = plan.vehicleWidth / 2
    const items = plan.cargoGroups
      .flatMap(group => Array.from({length: group.count}, () => group))
      .sort((a,b) => b.length*b.width-a.length*a.width)

    const requestedCount = items.length
    const modes: PlacementVariant[] = ['BALANCED','REAR','AXLE']
    for (const mode of modes) {
      const placed: Pallet[] = []

      for (const group of items) {
        const orientations = group.rotatable && group.length !== group.width
          ? [[group.length,group.width],[group.width,group.length]]
          : [[group.length,group.width]]

        let best: Pallet | undefined
        let bestScore = -Infinity

        for (const [length,width] of orientations) {
          const xs = new Set<number>([0, Math.max(0, plan.vehicleLength - length)])
          const ys = new Set<number>([0, Math.max(0, plan.vehicleWidth - width)])
          for (const p of [...placed,...blocked]) {
            xs.add(p.x); xs.add(p.x+p.length)
            ys.add(p.y); ys.add(p.y+p.width)
          }

          for (const y of ys) for (const x of xs) {
            const candidate = {
              id: placed.length + 1, length, width, height: group.height,
              weight: group.weight, x, y, rotatable: group.rotatable, stackable: false,
            } satisfies Pallet

            if (x < 0 || y < 0 || x + length > plan.vehicleLength || y + width > plan.vehicleWidth) continue
            if (blocked.some(z => overlaps(candidate,z)) || placed.some(p => overlaps(candidate,p))) continue

            const cx = x + length / 2
            const cy = y + width / 2
            const wall = (y === 0 ? 1 : 0) + (y + width === plan.vehicleWidth ? 1 : 0)
            const compact = placed.reduce((n,p) =>
              n
              + ((x + length === p.x || x === p.x + p.length) ? 2 : 0)
              + ((y + width === p.y || y === p.y + p.width) ? 2 : 0), 0)

            // Score the resulting load, not just the candidate.
            // This prevents the greedy solver from putting every pallet on one side.
            const totalWeight = fixedWeight + placed.reduce((sum,p) => sum + p.weight, 0) + candidate.weight
            const cgX = totalWeight > 0
              ? (fixedMomentX + placed.reduce((sum,p) => sum + p.weight * (p.x + p.length / 2), 0) + candidate.weight * cx) / totalWeight
              : targetX
            const cgY = totalWeight > 0
              ? (fixedMomentY + placed.reduce((sum,p) => sum + p.weight * (p.y + p.width / 2), 0) + candidate.weight * cy) / totalWeight
              : targetY

            const longitudinalPenalty =
              mode === 'REAR'
                ? Math.abs(cgX - Math.min(targetX, plan.vehicleLength * .30))
                : Math.abs(cgX - targetX)
            const transversePenalty = Math.abs(cgY - targetY)

            // Orientation is part of the alternative plan. When there are
            // only a few pallets, using the long side along X can be more
            // practical because it lets 3 EUR pallets fit across a 2.45 m
            // body. When the truck is heavily loaded, the short side along X
            // is usually more compact. The user can compare both variants.
            const longSideAlongX = length > width
            const shortSideAlongX = length < width
            const fewCargo = requestedCount <= 6
            const preferLongX =
              mode === 'REAR' || (mode === 'BALANCED' && fewCargo)
            const preferShortX =
              mode === 'AXLE' || (mode === 'BALANCED' && !fewCargo)
            const orientationBonus =
              (preferLongX && longSideAlongX ? 4000000 : 0) +
              (preferShortX && shortSideAlongX ? 4000000 : 0)

            // Strongly prefer the second pallet to use the opposite side
            // when a candidate keeps the resulting CG near the center.
            const sideDiversity = placed.length === 0 ? 0 : Math.min(
              placed.filter(p => p.y + p.width / 2 < targetY).length,
              placed.filter(p => p.y + p.width / 2 >= targetY).length
            )
            const candidateSide = cy < targetY ? 'top' : 'bottom'
            const oppositeSideBonus = placed.length > 0 && (
              (candidateSide === 'top' && placed.some(p => p.y + p.width / 2 >= targetY)) ||
              (candidateSide === 'bottom' && placed.some(p => p.y + p.width / 2 < targetY))
            ) ? 250000 : 0
            const topCount = placed.filter(p => p.y + p.width / 2 < targetY).length + (candidateSide === 'top' ? 1 : 0)
            const bottomCount = placed.filter(p => p.y + p.width / 2 >= targetY).length + (candidateSide === 'bottom' ? 1 : 0)
            const sideImbalance = Math.abs(topCount - bottomCount)

            const score =
              orientationBonus +
              oppositeSideBonus +
              wall * (mode === 'REAR' ? 220000 : 180000) +
              compact * 6000 +
              sideDiversity * 1000 -
              sideImbalance * 150000 -
              longitudinalPenalty * (mode === 'AXLE' ? 26000 : 18000) -
              transversePenalty * 200 -
              x * (mode === 'REAR' ? 10 : 1)

            if (score > bestScore) {
              bestScore = score
              best = candidate
            }
          }
        }
        if (best) placed.push(best)
      }

      variants.push({...plan, pallets: placed.map((p,i) => ({...p,id:i+1}))})
    }
    return variants
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
      plan.obstacles.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.unavailableZones.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.gaps.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.pallets.slice(i + 1).some(q => intersects(p, q))
    )
    const requestedCount = plan.cargoGroups.reduce((sum, group) => sum + group.count, 0)
    const unplacedCount = Math.max(0, requestedCount - plan.pallets.length)
    const placementViolation = geometryViolation || unplacedCount > 0
    const maxCargoHeight = plan.pallets.reduce((max, p) => Math.max(max, p.height), 0)
    const hasHeightData = plan.vehicleHeight > 0 && maxCargoHeight > 0

    // Расчётный центр тяжести и распределение веса по минимальной
    // двухосной модели. Если пользователь не ввёл оси, используем
    // условные позиции 70% и 90% длины кузова.
    const axlePositions = plan.axles.length >= 2
      ? plan.axles.map(a => a.position).sort((a, b) => a - b)
      : [plan.vehicleLength * 0.70, plan.vehicleLength * 0.90]
    const cgWeight = totalWeight
    const cgX = cgWeight > 0
      ? (plan.pallets.reduce((sum, p) => sum + p.weight * (p.x + p.length / 2), 0) + plan.obstacles.reduce((sum, o) => sum + (o.weight ?? 0) * (o.x + o.length / 2), 0)) / cgWeight
      : plan.vehicleLength / 2
    const cgY = cgWeight > 0
      ? (plan.pallets.reduce((sum, p) => sum + p.weight * (p.y + p.width / 2), 0) + plan.obstacles.reduce((sum, o) => sum + (o.weight ?? 0) * (o.y + o.width / 2), 0)) / cgWeight
      : plan.vehicleWidth / 2
    const axleLoads = axlePositions.length === 2 && cgWeight > 0
      ? [
          cgWeight * (axlePositions[1] - cgX) / (axlePositions[1] - axlePositions[0]),
          cgWeight * (cgX - axlePositions[0]) / (axlePositions[1] - axlePositions[0]),
        ]
      : []
    const axleLoadsValid = axleLoads.length === 2 && axleLoads.every(load => Number.isFinite(load) && load >= 0)
    const cgBetweenAxles = axlePositions.length === 2 && cgX >= axlePositions[0] && cgX <= axlePositions[1]
    const transverseShift = Math.abs(cgY - plan.vehicleWidth / 2) / plan.vehicleWidth
    const transverseImbalance = transverseShift > 0.25
    const axleValue = axleLoadsValid
      ? axleLoads.map((load, i) => 'Ось ' + (i + 1) + ': ' + new Intl.NumberFormat('ru-RU').format(Math.round(load)) + ' кг').join(' · ')
      : 'Центр массы вне базы осей'
    const axleCapacitiesKnown = plan.axles.length >= 2 && plan.axles.every(a => a.capacityKg > 0)
    const sortedAxles = plan.axles.slice().sort((a, b) => a.position - b.position)
    const axleCapacityViolation = axleCapacitiesKnown && axleLoadsValid && axleLoads.some((load, i) => load > sortedAxles[i].capacityKg)
    const cgValue = cgWeight > 0
      ? 'X ' + (cgX / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м · Y ' + (cgY / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' м'
      : '—'
    const heightViolation = hasHeightData && maxCargoHeight > plan.vehicleHeight
    const heightValue = hasHeightData ? `${(maxCargoHeight / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м / ${(plan.vehicleHeight / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м` : '—'
    return [
      { id: 'count', label: 'Размещение', value: `${plan.pallets.length} / ${requestedCount}`, status: placementViolation ? 'VIOLATION' : 'CHECKED', note: geometryViolation ? 'Есть выход за кузов, пересечение или недоступную зону' : unplacedCount > 0 ? `Не размещено: ${unplacedCount} шт. Недостаточно свободного места` : 'Все паллеты внутри кузова и не пересекаются' },
      { id: 'weight', label: 'Вес груза', value: unplacedCount > 0 ? `${new Intl.NumberFormat('ru-RU').format(totalWeight)} / ${new Intl.NumberFormat('ru-RU').format(requestedWeight)} кг` : `${new Intl.NumberFormat('ru-RU').format(totalWeight)} кг`, status: 'CHECKED', note: unplacedCount > 0 ? `Размещено ${new Intl.NumberFormat('ru-RU').format(totalWeight)} кг из ${new Intl.NumberFormat('ru-RU').format(requestedWeight)} кг` : 'Сумма введённых весов' },
      { id: 'axles', label: 'Нагрузка на оси', value: axleValue, status: axleCapacityViolation || !cgBetweenAxles || transverseImbalance ? 'VIOLATION' : axleLoadsValid ? 'CALCULATED' : 'NOT_CHECKED', note: axleCapacityViolation ? 'Расчётная нагрузка превышает введённую грузоподъёмность оси' : !cgBetweenAxles ? 'Центр массы находится вне базы осей — размещение требует перераспределения груза' : axleLoadsValid ? (transverseImbalance ? '⚠ Центр массы заметно смещён поперёк кузова — оцените распределение по бортам' : (axleCapacitiesKnown ? 'Расчётная нагрузка по указанным осям' : 'Расчёт по минимальной 2-осной модели; допустимая нагрузка осей не указана')) : 'Недостаточно данных для расчёта' },
      { id: 'height', label: 'Высота', value: heightValue, status: heightViolation ? 'VIOLATION' : hasHeightData ? 'CHECKED' : 'NOT_CHECKED', note: heightViolation ? 'Груз выше полезной высоты кузова' : hasHeightData ? 'Высота груза не превышает высоту кузова' : 'Нет данных для расчёта' },
      { id: 'payload', label: 'Грузоподъёмность', value: plan.payloadCapacityKg != null ? `${new Intl.NumberFormat('ru-RU').format(totalWeight)} / ${new Intl.NumberFormat('ru-RU').format(plan.payloadCapacityKg)} кг` : '—', status: plan.payloadCapacityKg != null ? (totalWeight > plan.payloadCapacityKg ? 'VIOLATION' : 'CHECKED') : 'NOT_CHECKED', note: plan.payloadCapacityKg != null ? (totalWeight > plan.payloadCapacityKg ? 'Размещённый груз превышает грузоподъёмность' : `Размещённый груз в пределах ${new Intl.NumberFormat('ru-RU').format(plan.payloadCapacityKg)} кг`) : 'Не указана грузоподъёмность' },
      { id: 'cg', label: 'Центр тяжести', value: cgValue, status: cgWeight > 0 ? 'CALCULATED' : 'NOT_CHECKED', note: cgWeight > 0 ? 'Расчётный центр массы размещённого груза' : 'Нет размещённого груза' },
      { id: 'area', label: 'Занятая площадь', value: `${occupied.toFixed(1)} м²`, status: 'CHECKED', note: 'Площадь паллет' },
    ]
  },
}