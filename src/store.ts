import { create } from 'zustand'
import { AssistantService, PlacementService, SolverService } from './services'
import type { Calculation, LoadPlan } from './types'

type Rect = { x: number; y: number; length: number; width: number }

const calculateCg = (plan: LoadPlan) => {
  const weighted = [
    ...plan.pallets.map(p => ({ weight: p.weight, x: p.x + p.length / 2, y: p.y + p.width / 2 })),
    ...plan.obstacles.map(o => ({ weight: o.weight ?? 0, x: o.x + o.length / 2, y: o.y + o.width / 2 })),
  ]
  const total = weighted.reduce((sum, item) => sum + item.weight, 0)
  return total > 0
    ? {
        x: weighted.reduce((sum, item) => sum + item.weight * item.x, 0) / total,
        y: weighted.reduce((sum, item) => sum + item.weight * item.y, 0) / total,
      }
    : { x: plan.vehicleLength / 2, y: plan.vehicleWidth / 2 }
}

const compactPallets = (plan: LoadPlan, preferredId: number): LoadPlan => {
  const blocked: Rect[] = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
  const targetCg = calculateCg(plan)
  const ordered = [...plan.pallets].sort((a, b) => {
    if (a.id === preferredId) return -1
    if (b.id === preferredId) return 1
    return (b.length * b.width) - (a.length * a.width) || a.id - b.id
  })
  const placed: LoadPlan['pallets'] = []

  for (const pallet of ordered) {
    const original = pallet

    // Якорь развёрнутой паллеты не двигаем повторно: остальные паллеты
    // уплотняются вокруг неё, чтобы действие водителя было предсказуемым.
    if (pallet.id === preferredId) {
      placed.push(pallet)
      continue
    }

    const xs = new Set<number>([0, original.x, Math.max(0, plan.vehicleLength - original.length)])
    const ys = new Set<number>([0, original.y, Math.max(0, plan.vehicleWidth - original.width)])
    for (const zone of [...blocked, ...placed]) {
      xs.add(zone.x)
      xs.add(zone.x + zone.length)
      ys.add(zone.y)
      ys.add(zone.y + zone.width)
    }

    const candidates: Array<{ x: number; y: number; score: number }> = []
    for (const x of xs) {
      for (const y of ys) {
        if (x < 0 || y < 0 || x + pallet.length > plan.vehicleLength || y + pallet.width > plan.vehicleWidth) continue
        const candidate = { ...pallet, x, y }
        if (blocked.some(zone => overlaps(candidate, zone)) || placed.some(other => overlaps(candidate, other))) continue

        const wallContact = (y === 0 ? 1 : 0) + (y + pallet.width === plan.vehicleWidth ? 1 : 0)
        const adjacent = [...blocked, ...placed].reduce((sum, zone) => {
          const verticalTouch = (x + pallet.length === zone.x || x === zone.x + zone.length) &&
            y < zone.y + zone.width && y + pallet.width > zone.y
          const horizontalTouch = (y + pallet.width === zone.y || y === zone.y + zone.width) &&
            x < zone.x + zone.length && x + pallet.length > zone.x
          return sum + (verticalTouch ? 1 : 0) + (horizontalTouch ? 1 : 0)
        }, 0)

        const partial = [...placed, candidate]
        const totalWeight = partial.reduce((sum, item) => sum + item.weight, 0)
        const partialCgX = totalWeight > 0
          ? partial.reduce((sum, item) => sum + item.weight * (item.x + item.length / 2), 0) / totalWeight
          : targetCg.x
        const partialCgY = totalWeight > 0
          ? partial.reduce((sum, item) => sum + item.weight * (item.y + item.width / 2), 0) / totalWeight
          : targetCg.y

        const frontSpan = Math.max(...partial.map(item => item.x + item.length))
        const sideSpan = Math.max(...partial.map(item => item.y + item.width))
        const distance = Math.hypot(candidate.x - original.x, candidate.y - original.y)
        const balancePenalty =
          Math.abs(partialCgX - targetCg.x) / 1000 * 900 +
          Math.abs(partialCgY - targetCg.y) / 1000 * 500

        const score =
          adjacent * 10000 +
          wallContact * 2200 -
          frontSpan * 2 -
          sideSpan * 0.7 -
          distance * 0.35 -
          balancePenalty

        candidates.push({ x, y, score })
      }
    }

    const best = candidates.sort((a, b) => b.score - a.score)[0]
    placed.push(best ? { ...pallet, x: best.x, y: best.y } : pallet)
  }

  return { ...plan, pallets: placed }
}

interface LoadPlanState {
  plan: LoadPlan | null
  variants: LoadPlan[]
  selectedVariant: number
  calculations: Calculation[]
  selectedPallet: number | null
  isLoading: boolean
  error: string | null
  setSelectedPallet: (id: number | null) => void
  rotateSelectedPallet: () => Promise<void>
  setSelectedPalletWeight: (weight: number) => Promise<void>
  rotationFeedback: { palletId: number; fromX: number; fromY: number; toX: number; toY: number } | null
  setSelectedVariant: (index: number) => Promise<void>
  setPlanVariants: (plans: LoadPlan[]) => Promise<void>
  loadDemo: () => Promise<void>
  setPlan: (plan: LoadPlan) => Promise<void>
}
export const useLoadPlanStore = create<LoadPlanState>((set, get) => ({
  plan: null, variants: [], selectedVariant: 0, calculations: [], selectedPallet: null, isLoading: false, error: null, rotationFeedback: null,
  setSelectedPallet: (selectedPallet) => set({ selectedPallet }),
  rotateSelectedPallet: async () => {
    const { plan, selectedPallet, variants, selectedVariant } = get()
    if (!plan || selectedPallet == null) return
    const pallet = plan.pallets.find(p => p.id === selectedPallet)
    if (!pallet || !pallet.rotatable || pallet.length === pallet.width) return

    const nextLength = pallet.width
    const nextWidth = pallet.length
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const overlaps = (a: Rect, b: Rect) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y

    // Важно: не требуем свободного места прямо под паллетой.
    // После разворота соседние паллеты тоже могут сдвинуться, поэтому
    // сначала ищем возможные позиции развёрнутой паллеты, а затем
    // перестраиваем окружение вокруг неё.
    const candidateXs = new Set<number>([0, Math.max(0, plan.vehicleLength - nextLength)])
    const candidateYs = new Set<number>([0, Math.max(0, plan.vehicleWidth - nextWidth)])
    for (const zone of blocked) {
      candidateXs.add(zone.x)
      candidateXs.add(zone.x + zone.length - nextLength)
      candidateYs.add(zone.y)
      candidateYs.add(zone.y + zone.width - nextWidth)
    }
    for (const other of plan.pallets) {
      if (other.id === pallet.id) continue
      candidateXs.add(other.x)
      candidateXs.add(other.x + other.length - nextLength)
      candidateYs.add(other.y)
      candidateYs.add(other.y + other.width - nextWidth)
    }

    const step = 100
    for (let x = 0; x <= plan.vehicleLength - nextLength; x += step) candidateXs.add(x)
    for (let y = 0; y <= plan.vehicleWidth - nextWidth; y += step) candidateYs.add(y)

    const originalCenterX = pallet.x + pallet.length / 2
    const originalCenterY = pallet.y + pallet.width / 2
    const candidates: Array<{ plan: LoadPlan; score: number }> = []

    for (const rawX of candidateXs) {
      for (const rawY of candidateYs) {
        const x = Math.max(0, Math.min(plan.vehicleLength - nextLength, rawX))
        const y = Math.max(0, Math.min(plan.vehicleWidth - nextWidth, rawY))
        const rotated = { ...pallet, x, y, length: nextLength, width: nextWidth }

        if (blocked.some(zone => overlaps(rotated, zone))) continue

        const basePlan: LoadPlan = {
          ...plan,
          pallets: plan.pallets.map(p => p.id === pallet.id ? rotated : p),
        }

        const compacted = compactPallets(basePlan, pallet.id)
        const valid = compacted.pallets.every((a, index, all) =>
          a.x >= 0 && a.y >= 0 &&
          a.x + a.length <= plan.vehicleLength &&
          a.y + a.width <= plan.vehicleWidth &&
          !blocked.some(zone => overlaps(a, zone)) &&
          all.slice(index + 1).every(b => !overlaps(a, b))
        )
        if (!valid) continue

        const distance = Math.hypot(x - (originalCenterX - nextLength / 2), y - (originalCenterY - nextWidth / 2))
        const cg = calculateCg(compacted)
        const originalCg = calculateCg(plan)
        const cgShift = Math.hypot(cg.x - originalCg.x, cg.y - originalCg.y)

        const occupiedMaxX = Math.max(...compacted.pallets.map(p => p.x + p.length))
        const occupiedMaxY = Math.max(...compacted.pallets.map(p => p.y + p.width))
        const adjacency = compacted.pallets.reduce((sum, current) => {
          return sum + compacted.pallets.filter(other => other.id !== current.id).reduce((inner, other) => {
            const verticalTouch = (current.x + current.length === other.x || current.x === other.x + other.length) &&
              current.y < other.y + other.width && current.y + current.width > other.y
            const horizontalTouch = (current.y + current.width === other.y || current.y === other.y + other.width) &&
              current.x < other.x + other.length && current.x + current.length > other.x
            return inner + (verticalTouch || horizontalTouch ? 1 : 0)
          }, 0)
        }, 0)

        const score =
          adjacency * 1800 -
          occupiedMaxX * 1.8 -
          occupiedMaxY * 0.6 -
          distance * 0.25 -
          cgShift * 0.8

        candidates.push({ plan: compacted, score })
      }
    }

    const best = candidates.sort((a, b) => b.score - a.score)[0]
    if (!best) {
      set({ error: 'Развернуть нельзя: для новой ориентации не удалось построить свободную схему.' })
      return
    }

    const nextSummary = await SolverService.summarize(best.plan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? best.plan : v)
    const from = calculateCg(plan)
    const to = calculateCg(best.plan)

    set({
      plan: best.plan,
      variants: nextVariants,
      calculations: nextSummary,
      rotationFeedback: {
        palletId: pallet.id,
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
      },
      error: null,
    })
  },
  setSelectedPalletWeight: async (weight) => {
    const { plan, selectedPallet, variants, selectedVariant } = get()
    if (!plan || selectedPallet == null || !Number.isFinite(weight) || weight < 1) return
    const nextPlan = { ...plan, pallets: plan.pallets.map(p => p.id === selectedPallet ? { ...p, weight } : p) }
    const calculations = await SolverService.summarize(nextPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? nextPlan : v)
    set({ plan: nextPlan, variants: nextVariants, calculations, error: null })
  },
  setSelectedVariant: async (selectedVariant) => {
    const variants = get().variants
    const plan = variants[selectedVariant]
    if (!plan) return
    set({ isLoading: true, error: null })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, calculations, selectedVariant, selectedPallet: plan.pallets[0]?.id ?? null, isLoading: false, rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось переключить вариант' }) }
  },
  setPlanVariants: async (plans) => {
    const plan = plans[0]
    if (!plan) return
    set({ isLoading: true, error: null, variants: plans, selectedVariant: 0 })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, variants: plans, selectedVariant: 0, calculations, isLoading: false, selectedPallet: plan.pallets[0]?.id ?? null })
    } catch { set({ isLoading: false, error: 'Не удалось построить варианты' }) }
  },
  loadDemo: async () => {
    set({ isLoading: true, error: null })
    try {
      const plan = await AssistantService.createDemo()
      const variants = PlacementService.createVariants(plan)
      const calculations = await SolverService.summarize(plan)
      set({ plan, variants, selectedVariant: 0, calculations, isLoading: false, selectedPallet: 1, rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось построить демо-план' }) }
  },
  setPlan: async (plan) => {
    set({ isLoading: true, error: null })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, calculations, isLoading: false, selectedPallet: plan.pallets[0]?.id ?? null })
    } catch { set({ isLoading: false, error: 'Не удалось построить план' }) }
  },
}))