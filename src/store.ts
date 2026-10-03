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
    const centerX = pallet.x + pallet.length / 2
    const centerY = pallet.y + pallet.width / 2
    const blocked = [...plan.obstacles, ...plan.unavailableZones, ...plan.gaps]
    const overlaps = (a: Rect, b: Rect) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    const isFree = (x: number, y: number, currentPallet = pallet) => {
      const candidate = { ...currentPallet, x, y, length: nextLength, width: nextWidth }
      return x >= 0 && y >= 0 &&
        x + nextLength <= plan.vehicleLength &&
        y + nextWidth <= plan.vehicleWidth &&
        !blocked.some(zone => overlaps(candidate, zone)) &&
        !plan.pallets.some(other => other.id !== pallet.id && overlaps(candidate, other))
    }

    const nearestCandidates: Array<{ x: number; y: number; distance: number }> = []
    const exactX = centerX - nextLength / 2
    const exactY = centerY - nextWidth / 2
    if (isFree(exactX, exactY)) nearestCandidates.push({ x: exactX, y: exactY, distance: 0 })
    const step = 50
    const radius = Math.max(nextLength, nextWidth)
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        const x = Math.round((exactX + dx) / step) * step
        const y = Math.round((exactY + dy) / step) * step
        if (isFree(x, y)) nearestCandidates.push({ x, y, distance: Math.hypot(x - exactX, y - exactY) })
      }
    }
    const nearest = nearestCandidates.sort((a, b) => a.distance - b.distance)[0]
    if (!nearest) {
      set({ error: 'Развернуть нельзя: рядом нет свободного места. Попробуйте уплотнить груз вручную.' })
      return
    }

    const rotatedPlan: LoadPlan = {
      ...plan,
      pallets: plan.pallets.map(p => p.id === pallet.id
        ? { ...p, length: nextLength, width: nextWidth, x: nearest.x, y: nearest.y }
        : p),
    }

    // После разворота автоматически уплотняем весь ряд: выбранная паллета
    // сохраняет новую ориентацию, остальные сдвигаются только в свободные
    // точки, не пересекают препятствия и стараются сохранить исходный ЦМ.
    const compactedPlan = compactPallets(rotatedPlan, pallet.id)
    const nextSummary = await SolverService.summarize(compactedPlan)
    const nextVariants = variants.map((v, i) => i === selectedVariant ? compactedPlan : v)

    const from = calculateCg(plan)
    const to = calculateCg(compactedPlan)
    set({
      plan: compactedPlan,
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