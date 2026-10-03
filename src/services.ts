import type { Calculation, LoadPlan, Pallet } from './types'

export const AssistantService = {
  async createDemo(): Promise<LoadPlan> {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const pallets: Pallet[] = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1, length: 1200, width: 800, weight: 450,
      x: index < 5 ? 280 + index * 1220 : 280 + (index - 5) * 1220,
      y: index < 5 ? 180 : 1070,
    }))
    return { vehicleLength: 6000, vehicleWidth: 2050, vehicleHeight: 2200, pallets }
  },
}

export const SpeechService = {
  async listen(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return 'Добавить 10 европаллет по 450 килограммов'
  },
}

export const SolverService = {
  async summarize(plan: LoadPlan): Promise<Calculation[]> {
    await new Promise((resolve) => setTimeout(resolve, 180))
    const totalWeight = plan.pallets.reduce((sum, pallet) => sum + pallet.weight, 0)
    return [
      { label: 'Вес груза', value: `${new Intl.NumberFormat('ru-RU').format(totalWeight)} кг`, status: 'CHECKED', note: 'В пределах допустимой нагрузки' },
      { label: 'Занятая площадь', value: `${(plan.pallets.length * 1200 * 800 / 1_000_000).toFixed(1)} м²`, status: 'CHECKED', note: 'Расположение проверено' },
      { label: 'Свободный проход', value: '0 мм', status: 'VIOLATION', note: 'Требуется подтвердить правило прохода' },
      { label: 'Осевая нагрузка', value: '—', status: 'NOT_CHECKED', note: 'Расчёт осей недоступен на этапе 1' },
    ]
  },
}
