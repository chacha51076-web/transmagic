import type { Calculation, LoadPlan, Pallet } from './types'

const demoPallet = (id: number, x: number, y: number): Pallet => ({
  id, length: 1200, width: 800, height: 0, weight: 450, x, y, rotatable: true, stackable: false,
})

export const AssistantService = {
  async createDemo(): Promise<LoadPlan> {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const xs = [0, 1200, 2400, 3600]
    const pallets = [
      demoPallet(1, xs[0], 0), demoPallet(2, xs[1], 0), demoPallet(3, xs[2], 0), demoPallet(4, xs[3], 0),
      demoPallet(5, xs[0], 800), demoPallet(6, xs[1], 800), demoPallet(7, xs[2], 800), demoPallet(8, xs[3], 800),
      demoPallet(9, 0, 1600), demoPallet(10, 1200, 1600),
    ]
    return {
      vehicleLength: 6000, vehicleWidth: 2050, vehicleHeight: 2200,
      payloadCapacityKg: undefined,
      doors: [{ id: 'rear', x: 0, y: 0, length: 230, width: 2050, label: 'Двери' }],
      gaps: [], obstacles: [{ id: 'cooler', x: 4800, y: 0, length: 420, width: 540, label: 'Охладитель' }],
      unavailableZones: [], axles: [],
      cargoGroups: [{ id: 'eur', name: 'EUR паллета', length: 1200, width: 800, height: 0, weight: 450, count: 10, rotatable: true, stackable: false }],
      pallets,
    }
  },
}

export const SpeechService = {
  async listen(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 700))
    return 'Добавить 10 европаллет по 450 килограммов'
  },
}

export const SolverService = {
  async summarize(plan: LoadPlan): Promise<Calculation[]> {
    await new Promise((resolve) => setTimeout(resolve, 180))
    const totalWeight = plan.pallets.reduce((sum, p) => sum + p.weight, 0)
    const occupied = plan.pallets.reduce((sum, p) => sum + p.length * p.width, 0) / 1_000_000
    const intersects = (a: Pallet, b: Pallet) =>
      a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y
    const geometryViolation = plan.pallets.some((p, i) =>
      p.x < 0 || p.y < 0 || p.x + p.length > plan.vehicleLength || p.y + p.width > plan.vehicleWidth ||
      plan.obstacles.some(o => p.x < o.x + o.length && p.x + p.length > o.x && p.y < o.y + o.width && p.y + p.width > o.y) ||
      plan.pallets.slice(i + 1).some(q => intersects(p, q))
    )
    return [
      { id: 'count', label: 'Размещение', value: geometryViolation ? 'Конфликт' : `${plan.pallets.length} / 10`, status: geometryViolation ? 'VIOLATION' : 'CHECKED', note: geometryViolation ? 'Есть выход за кузов или пересечение' : 'Все паллеты внутри кузова и не пересекаются' },
      { id: 'weight', label: 'Вес груза', value: `${new Intl.NumberFormat('ru-RU').format(totalWeight)} кг`, status: 'CHECKED', note: 'Сумма введённых весов' },
      { id: 'axles', label: 'Нагрузка на оси', value: '—', status: 'NOT_CHECKED', note: 'Не проверена на этапе 1' },
      { id: 'height', label: 'Высота', value: '—', status: 'NOT_CHECKED', note: 'Нет данных для расчёта' },
      { id: 'payload', label: 'Грузоподъёмность', value: '—', status: 'NOT_CHECKED', note: 'Не проверена на этапе 1' },
      { id: 'cg', label: 'Центр тяжести', value: '—', status: 'NOT_CHECKED', note: 'Не рассчитан на этапе 1' },
      { id: 'area', label: 'Занятая площадь', value: `${occupied.toFixed(1)} м²`, status: 'CHECKED', note: 'Площадь паллет' },
    ]
  },
}