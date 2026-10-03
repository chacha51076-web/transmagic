import { create } from 'zustand'
import { AssistantService, PlacementService, SolverService } from './services'
import type { Calculation, LoadPlan } from './types'

type Rect = { x: number; y: number; length: number; width: number }

const normalizePlanEquipment = (plan: LoadPlan): LoadPlan => {
  const cooler = {
    id: 'cooler',
    x: Math.max(0, plan.vehicleLength - plan.fixedCooler.projection),
    y: Math.max(0, (plan.vehicleWidth - plan.fixedCooler.width) / 2),
    length: plan.fixedCooler.projection,
    width: plan.fixedCooler.width,
    height: plan.fixedCooler.height,
    label: 'Холодильная установка',
    blocksFloor: false,
  }
  return {
    ...plan,
    obstacles: [cooler, ...plan.obstacles.filter(obstacle => obstacle.id !== 'cooler')],
  }
}

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
  moveAxlePosition: (id: string, x: number) => Promise<boolean>
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
    const blocked = [...plan.obstacles.filter(o => o.blocksFloor !== false), ...plan.unavailableZones, ...plan.gaps]
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
    const nextPlan = normalizePlanEquipment({
      ...plan,
      pallets: plan.pallets.map(p => p.id === pallet.id ? rotated : p),
    })
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
    const blocked = [...plan.obstacles.filter(o => o.blocksFloor !== false), ...plan.unavailableZones, ...plan.gaps]
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
    const nextPlan = normalizePlanEquipment({
      ...plan,
      pallets: plan.pallets.map(p => p.id === id ? candidate : p),
    })
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
  moveAxlePosition: async (id, x) => {
    const { plan, variants, selectedVariant } = get()
    if (!plan || plan.axles.length < 2 || !Number.isFinite(x)) return false
    const sorted = plan.axles.slice().sort((a, b) => a.position - b.position)
    const targetIndex = sorted.findIndex(axle => axle.id === id)
    if (targetIndex < 0) return false
    const minGap = 500
    const minX = targetIndex > 0 ? sorted[targetIndex - 1].position + minGap : 0
    const maxX = targetIndex < sorted.length - 1 ? sorted[targetIndex + 1].position - minGap : plan.vehicleLength
    if (x < minX || x > maxX) {
      set({ error: 'Ось нельзя поставить в эту позицию: сохраняйте порядок и расстояние между осями.' })
      return false
    }
    const rounded = Math.round(x / 50) * 50
    const nextAxles = plan.axles.map(axle => ({
      ...axle,
      position: axle.id === id ? rounded : axle.position,
      source: 'FIXED' as const,
    }))
    const nextPlan = normalizePlanEquipment({ ...plan, axles: nextAxles })
    const nextVariants = variants.map(variant => ({
      ...variant,
      axles: variant.axles.map(axle => {
        const updated = nextAxles.find(next => next.id === axle.id)
        return updated ? { ...axle, position: updated.position, source: 'FIXED' as const } : axle
      }),
    }))

    // Сначала фиксируем новую позицию в состоянии. Расчёт выполняется после этого
    // и больше не может визуально вернуть ось в старое положение.
    set(state => ({
      history: [...state.history, plan].slice(-30),
      plan: nextPlan,
      variants: nextVariants,
      selectedVariant,
      error: null,
      rotationFeedback: null,
    }))

    const calculations = await SolverService.summarize(nextPlan)
    set({ calculations })
    return true
  },

  setSelectedPalletWeight: async (weight) => {
    const { plan, selectedPallet, variants, selectedVariant } = get()
    if (!plan || selectedPallet == null || !Number.isFinite(weight) || weight < 1) return
    const nextPlan = normalizePlanEquipment({ ...plan, pallets: plan.pallets.map(p => p.id === selectedPallet ? { ...p, weight } : p) })
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
    const previous = normalizePlanEquipment(history[history.length - 1])
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
    const plan = variants[selectedVariant] ? normalizePlanEquipment(variants[selectedVariant]) : null
    if (!plan) return
    set({ isLoading: true, error: null })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, calculations, selectedVariant, selectedPallet: plan.pallets[0]?.id ?? null, isLoading: false, history: [], rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось переключить вариант' }) }
  },
  setPlanVariants: async (plans) => {
    const plan = plans[0] ? normalizePlanEquipment(plans[0]) : null
    if (!plan) return
    const normalizedVariants = plans.map(normalizePlanEquipment)
    set({ isLoading: true, error: null, variants: normalizedVariants, selectedVariant: 0 })
    try {
      const calculations = await SolverService.summarize(plan)
      set({ plan, variants: normalizedVariants, selectedVariant: 0, calculations, isLoading: false, selectedPallet: plan.pallets[0]?.id ?? null, history: [], rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось построить варианты' }) }
  },
  loadDemo: async () => {
    set({ isLoading: true, error: null })
    try {
      const plan = normalizePlanEquipment(await AssistantService.createDemo())
      const generatedVariants = PlacementService.createVariants(plan)
      // Демо должно показывать именно заранее рассчитанную валидную 10/10 раскладку,
      // а не сырую схему до оптимизации. Остальные варианты остаются альтернативами.
      const variants = [plan, ...generatedVariants.slice(1)]
      const calculations = await SolverService.summarize(plan)
      set({ plan, variants, selectedVariant: 0, calculations, isLoading: false, selectedPallet: plan.pallets[0]?.id ?? null, history: [], rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось построить демо-план' }) }
  },
  setPlan: async (plan) => {
    const normalizedPlan = normalizePlanEquipment(plan)
    set({ isLoading: true, error: null })
    try {
      const calculations = await SolverService.summarize(normalizedPlan)
      set({ plan: normalizedPlan, calculations, isLoading: false, selectedPallet: normalizedPlan.pallets[0]?.id ?? null, history: [], rotationFeedback: null })
    } catch { set({ isLoading: false, error: 'Не удалось построить план' }) }
  },
}))