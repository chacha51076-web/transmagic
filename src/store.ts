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
  history: LoadPlan[]
  setSelectedPallet: (id: number | null) => void
  rotateSelectedPallet: () => Promise<void>
  movePallet: (id: number, x: number, y: number) => Promise<boolean>
  undoLastMove: () => Promise<void>
  suggestVariant: () => Promise<void>
  setSelectedPalletWeight: (weight: number) => Promise<void>
  rotationFeedback: { palletId: number; fromX: number; fromY: number; toX: number; toY: number } | null
  setSelectedVariant: (index: number) => Promise<void>
  setPlanVariants: (plans: LoadPlan[]) => Promise<void>
  loadDemo: () => Promise<void>
  setPlan: (plan: LoadPlan) => Promise<void>
}
export const useLoadPlanStore = create<LoadPlanState>((set, get) => ({
  plan: null, variants: [], selectedVariant: 0, calculations: [], selectedPallet: null, isLoading: false, error: null, history: [], rotationFeedback: null,
  setSelectedPallet: (selectedPallet) => set({ selectedPallet }),
  rotateSelectedPallet: async () => {
    const { plan, selectedPallet, variants, selectedVariant } = get()
    if (!plan || selectedPallet == null) return
    const pallet = plan.pallets.find(p => p.id === selectedPallet)
    if (!pallet || !pallet.rotatable || pallet.length === pallet.width) return
    const rotated = { ...pallet, length: pallet.width, width: pallet.length }
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const overlaps = (a: Rect, z: Rect) =>
      a.x < z.x + z.length && a.x + a.length > z.x &&
      a.y < z.y + z.width && a.y + a.width > z.y
    const valid =
      rotated.x >= 0 && rotated.y >= 0 &&
      rotated.x + rotated.length <= plan.vehicleLength &&
      rotated.y + rotated.width <= plan.vehicleWidth &&
      !blocked.some(z => overlaps(rotated, z)) &&
      plan.pallets.filter(p => p.id !== pallet.id).every(other => !overlaps(rotated, other))
    if (!valid) {
      set({ error: "Развернуть нельзя в текущем месте. Переместите паллету в свободную зону и повторите." })
      return
    }
    const nextPlan = {
      ...plan,
      pallets: plan.pallets.map(p => p.id === pallet.id ? rotated : p),
    }
    const calculations = await SolverService.summarize(nextPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? nextPlan : v)
    const from = calculateCg(plan)
    const to = calculateCg(nextPlan)
    set(state => ({
      history: [...state.history, plan].slice(-30),
      plan: nextPlan,
      variants: nextVariants,
      calculations,
      rotationFeedback: { palletId: pallet.id, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y },
      error: null,
    }))
  },

  movePallet: async (id, x, y) => {
    const { plan, variants, selectedVariant } = get()
    if (!plan) return false
    const pallet = plan.pallets.find(p => p.id === id)
    if (!pallet) return false
    const candidate = { ...pallet, x, y }
    const overlaps = (a: Rect, z: Rect) =>
      a.x < z.x + z.length && a.x + a.length > z.x &&
      a.y < z.y + z.width && a.y + a.width > z.y
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const valid =
      candidate.x >= 0 && candidate.y >= 0 &&
      candidate.x + candidate.length <= plan.vehicleLength &&
      candidate.y + candidate.width <= plan.vehicleWidth &&
      !blocked.some(z => overlaps(candidate, z)) &&
      plan.pallets.filter(p => p.id !== id).every(other => !overlaps(candidate, other))
    if (!valid) {
      set({ error: "Паллету нельзя поставить сюда: пересечение или выход за границы кузова." })
      return false
    }
    const nextPlan = {
      ...plan,
      pallets: plan.pallets.map(p => p.id === id ? candidate : p),
    }
    const calculations = await SolverService.summarize(nextPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? nextPlan : v)
    set(state => ({
      history: [...state.history, plan].slice(-30),
      plan: nextPlan,
      variants: nextVariants,
      calculations,
      rotationFeedback: null,
      error: null,
    }))
    return true
  },
  setSelectedPalletWeight: async (weight) => {
    const { plan, selectedPallet, variants, selectedVariant } = get()
    if (!plan || selectedPallet == null || !Number.isFinite(weight) || weight < 1) return
    const nextPlan = { ...plan, pallets: plan.pallets.map(p => p.id === selectedPallet ? { ...p, weight } : p) }
    const calculations = await SolverService.summarize(nextPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? nextPlan : v)
    set(state => ({
      history: [...state.history, plan].slice(-30),
      plan: nextPlan,
      variants: nextVariants,
      calculations,
      rotationFeedback: null,
      error: null,
    }))
  },

  undoLastMove: async () => {
    const { plan, history, variants, selectedVariant, selectedPallet } = get()
    if (!plan || history.length === 0) return
    const previous = history[history.length - 1]
    const calculations = await SolverService.summarize(previous)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? previous : v)
    set({
      plan: previous,
      variants: nextVariants,
      calculations,
      history: history.slice(0, -1),
      selectedPallet: previous.pallets.find(p => p.id === selectedPallet)?.id ?? previous.pallets[0]?.id ?? null,
      rotationFeedback: null,
      error: null,
    })
  },

  suggestVariant: async () => {
    const { variants, selectedVariant } = get()
    if (variants.length < 2) {
      set({ error: "Пока доступен только один рассчитанный вариант." })
      return
    }
    const nextIndex = selectedVariant === variants.length - 1 ? 0 : selectedVariant + 1
    await get().setSelectedVariant(nextIndex)
    set({ error: null })
  },

  setSelectedVariant: async (selectedVariant) => {
    const variants = get().variants
    const plan = variants[selectedVariant]
    if (!plan) return
    set({ isLoading: true, error: null })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, calculations, selectedVariant, selectedPallet: plan.pallets[0]?.id ?? null, isLoading: false, history: [], rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось переключить вариант' }) }
  },
  setPlanVariants: async (plans) => {
    const plan = plans[0]
    if (!plan) return
    set({ isLoading: true, error: null, variants: plans, selectedVariant: 0 })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, variants: plans, selectedVariant: 0, calculations, isLoading: false, selectedPallet: plan.pallets[0]?.id ?? null, history: [], rotationFeedback: null })
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
      set({ plan, calculations, isLoading: false, selectedPallet: plan.pallets[0]?.id ?? null, history: [], rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось построить план' }) }
  },
}))