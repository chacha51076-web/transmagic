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
  setSelectedVariant: (index: number) => Promise<void>
  setPlanVariants: (plans: LoadPlan[]) => Promise<void>
  loadDemo: () => Promise<void>
  setPlan: (plan: LoadPlan) => Promise<void>
}
export const useLoadPlanStore = create<LoadPlanState>((set, get) => ({
  plan: null, variants: [], selectedVariant: 0, calculations: [], selectedPallet: null, isLoading: false, error: null,
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
    const candidate = { ...pallet, length: nextLength, width: nextWidth, x: nextX, y: nextY }
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const invalid = nextX < 0 || nextY < 0 || nextX + nextLength > plan.vehicleLength || nextY + nextWidth > plan.vehicleWidth ||
      blocked.some(b => overlaps(candidate, b)) ||
      plan.pallets.some(p => p.id !== pallet.id && overlaps(candidate, p))
    if (invalid) {
      set({ error: 'Паллету нельзя развернуть в этом месте: не хватает свободного пространства.' })
      return
    }
    const nextPlan = { ...plan, pallets: plan.pallets.map(p => p.id === pallet.id ? candidate : p) }
    const calculations = await SolverService.summarize(nextPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? nextPlan : v)
    set({ plan: nextPlan, variants: nextVariants, calculations, error: null })
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
      set({ plan, calculations, selectedVariant, selectedPallet: plan.pallets[0]?.id ?? null, isLoading: false })
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
      set({ plan, variants, selectedVariant: 0, calculations, isLoading: false, selectedPallet: 1 })
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