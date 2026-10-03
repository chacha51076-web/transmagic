import { create } from 'zustand'
import { AssistantService, SolverService } from './services'
import type { Calculation, LoadPlan } from './types'

interface LoadPlanState {
  plan: LoadPlan | null
  calculations: Calculation[]
  selectedPallet: number | null
  isLoading: boolean
  error: string | null
  setSelectedPallet: (id: number | null) => void
  loadDemo: () => Promise<void>
  setPlan: (plan: LoadPlan) => Promise<void>
}
export const useLoadPlanStore = create<LoadPlanState>((set) => ({
  plan: null, calculations: [], selectedPallet: null, isLoading: false, error: null,
  setSelectedPallet: (selectedPallet) => set({ selectedPallet }),
  loadDemo: async () => {
    set({ isLoading: true, error: null })
    try {
      const plan = await AssistantService.createDemo()
      const calculations = await SolverService.summarize(plan)
      set({ plan, calculations, isLoading: false, selectedPallet: 1 })
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