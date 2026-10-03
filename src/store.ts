import { create } from 'zustand'
import { AssistantService, PlacementService, SolverService } from './services'
import type { Calculation, LoadPlan } from './types'

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
    const cx = pallet.x + pallet.length / 2
    const cy = pallet.y + pallet.width / 2
    const nextX = cx - nextLength / 2
    const nextY = cy - nextWidth / 2
    const overlaps = (a: {x:number;y:number;length:number;width:number}, b: {x:number;y:number;length:number;width:number}) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const isFree = (x: number, y: number) => {
      const candidate = { ...pallet, length: nextLength, width: nextWidth, x, y }
      return x >= 0 && y >= 0 && x + nextLength <= plan.vehicleLength && y + nextWidth <= plan.vehicleWidth &&
        !blocked.some(b => overlaps(candidate, b)) &&
        !plan.pallets.some(p => p.id !== pallet.id && overlaps(candidate, p))
    }
    const candidates: Array<{ x: number; y: number; distance: number }> = []
    if (isFree(nextX, nextY)) candidates.push({ x: nextX, y: nextY, distance: 0 })
    const step = 50
    const radius = Math.max(nextLength, nextWidth)
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        const x = Math.round((cx - nextLength / 2 + dx) / step) * step
        const y = Math.round((cy - nextWidth / 2 + dy) / step) * step
        if (isFree(x, y)) candidates.push({ x, y, distance: Math.hypot(x - nextX, y - nextY) })
      }
    }
    const best = candidates.sort((a, b) => a.distance - b.distance)[0]
    if (!best) {
      set({ error: 'Развернуть нельзя: рядом нет свободного места. Выберите другую паллету или сначала освободите место.' })
      return
    }
    const candidate = { ...pallet, length: nextLength, width: nextWidth, x: best.x, y: best.y }
    const nextPlan = { ...plan, pallets: plan.pallets.map(p => p.id === pallet.id ? candidate : p) }
    const beforeSummary = await SolverService.summarize(plan)
    const nextSummary = await SolverService.summarize(nextPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? nextPlan : v)
    const totalBefore = plan.pallets.reduce((sum, p) => sum + p.weight, 0)
    const totalAfter = nextPlan.pallets.reduce((sum, p) => sum + p.weight, 0)
    const from = totalBefore > 0 ? {
      x: plan.pallets.reduce((sum, p) => sum + p.weight * (p.x + p.length / 2), 0) / totalBefore,
      y: plan.pallets.reduce((sum, p) => sum + p.weight * (p.y + p.width / 2), 0) / totalBefore,
    } : { x: plan.vehicleLength / 2, y: plan.vehicleWidth / 2 }
    const to = totalAfter > 0 ? {
      x: nextPlan.pallets.reduce((sum, p) => sum + p.weight * (p.x + p.length / 2), 0) / totalAfter,
      y: nextPlan.pallets.reduce((sum, p) => sum + p.weight * (p.y + p.width / 2), 0) / totalAfter,
    } : { x: nextPlan.vehicleLength / 2, y: nextPlan.vehicleWidth / 2 }
    void beforeSummary
    set({ plan: nextPlan, variants: nextVariants, calculations: nextSummary, rotationFeedback: { palletId: pallet.id, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, error: null })
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