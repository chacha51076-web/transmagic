import { useState, type ReactNode } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { SpeechService } from './services'
import { useLoadPlanStore } from './store'
import type { CheckStatus, CargoGroup, LoadPlan } from './types'
import './styles.css'

const numberField = z.preprocess(v => typeof v === 'string' ? Number(v.replace(',', '.')) : v, z.number().finite())
const optionalNumberField = z.preprocess(v => v === '' || v === undefined ? undefined : typeof v === 'string' ? Number(v.replace(',', '.')) : v, z.number().finite().optional())
const schema = z.object({
  vehicleLength: numberField.pipe(z.number().min(1000)), vehicleWidth: numberField.pipe(z.number().min(500)), vehicleHeight: numberField.pipe(z.number().min(500)),
  payloadCapacityKg: optionalNumberField, doorWidth: numberField.pipe(z.number().min(0)), gap: numberField.pipe(z.number().min(0)),
  obstacleX: numberField.pipe(z.number().min(0)), obstacleY: numberField.pipe(z.number().min(0)), obstacleLength: numberField.pipe(z.number().min(0)), obstacleWidth: numberField.pipe(z.number().min(0)),
  unavailable: z.boolean(), axleCount: z.coerce.number().int().min(0).max(8),
  cargoLength: numberField.pipe(z.number().min(1)), cargoWidth: numberField.pipe(z.number().min(1)), cargoHeight: numberField.pipe(z.number().min(0)),
  quantity: z.coerce.number().int().min(1).max(100), palletWeight: numberField.pipe(z.number().min(1)), rotatable: z.boolean(),
})
type FormValues = z.infer<typeof schema>
const statusClass: Record<CheckStatus, string> = { CHECKED: 'status-ok', VIOLATION: 'status-bad', NOT_CHECKED: 'status-idle' }
const statusText: Record<CheckStatus, string> = { CHECKED: 'ПРОВЕРЕНО', VIOLATION: 'НАРУШЕНИЕ', NOT_CHECKED: 'НЕ ПРОВЕРЕНО' }
const presets = [
  ['EUR 1200 × 800', 1200, 800], ['1200 × 1000', 1200, 1000], ['1200 × 1200', 1200, 1200], ['Свои размеры', 0, 0],
] as const

function Field({ label, input, error }: { label: string; input: ReactNode; error?: string }) {
  return <label className="field"><span>{label}</span>{input}{error && <em>{error}</em>}</label>
}

function PlanForm() {
  const setPlan = useLoadPlanStore(s => s.setPlan)
  const [listening, setListening] = useState(false)
  const [recognized, setRecognized] = useState('')
  const [preset, setPreset] = useState(0)
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      vehicleLength: 6000, vehicleWidth: 2050, vehicleHeight: 2200, payloadCapacityKg: undefined, doorWidth: 230, gap: 0,
      obstacleX: 5230, obstacleY: 700, obstacleLength: 420, obstacleWidth: 540, unavailable: false, axleCount: 0,
      cargoLength: 1200, cargoWidth: 800, cargoHeight: 0, quantity: 10, palletWeight: 450, rotatable: true,
    },
  })
  const submit = (v: FormValues) => {
    const cargoGroup: CargoGroup = { id: 'cargo', name: preset === 0 ? 'EUR паллета' : 'Груз', length: v.cargoLength, width: v.cargoWidth, height: v.cargoHeight, weight: v.palletWeight, count: v.quantity, rotatable: v.rotatable, stackable: false }
    const pallets = Array.from({ length: v.quantity }, (_, i) => {
      const col = i % 5, row = Math.floor(i / 5)
      return { id: i + 1, length: v.cargoLength, width: v.cargoWidth, height: v.cargoHeight, weight: v.palletWeight, x: 300 + col * (v.cargoLength + 20), y: 120 + row * (v.cargoWidth + 20), rotatable: v.rotatable, stackable: false }
    })
    const plan: LoadPlan = {
      vehicleLength: v.vehicleLength, vehicleWidth: v.vehicleWidth, vehicleHeight: v.vehicleHeight, payloadCapacityKg: v.payloadCapacityKg,
      doors: [{ id: 'rear', x: 0, y: 0, length: v.doorWidth, width: v.vehicleWidth, label: 'Двери' }],
      gaps: v.gap ? [{ id: 'gap', x: v.doorWidth, y: 0, length: v.gap, width: v.vehicleWidth, label: 'Зазор' }] : [],
      obstacles: v.obstacleLength && v.obstacleWidth ? [{ id: 'obstacle', x: v.obstacleX, y: v.obstacleY, length: v.obstacleLength, width: v.obstacleWidth, label: 'Препятствие' }] : [],
      unavailableZones: v.unavailable ? [{ id: 'unavailable', x: 0, y: 0, length: 0, width: 0, label: 'Недоступная зона' }] : [],
      axles: Array.from({ length: v.axleCount }, (_, i) => ({ id: `axle-${i + 1}`, position: v.vehicleLength * (i + 1) / (v.axleCount + 1), capacityKg: 0 })),
      cargoGroups: [cargoGroup], pallets,
    }
    void setPlan(plan)
  }
  const speak = async () => {
    setListening(true)
    try { setRecognized(await SpeechService.listen()) } finally { setListening(false) }
  }
  const applyPreset = (i: number) => {
    setPreset(i)
    if (presets[i][1]) { setValue('cargoLength', presets[i][1]); setValue('cargoWidth', presets[i][2]) }
  }
  return <form onSubmit={handleSubmit(submit)} className="plan-form">
    <div className="section-label">Кузов, двери и зазоры</div>
    <div className="field-grid three"><Field label="Длина, мм" input={<input {...register('vehicleLength')} />} error={errors.vehicleLength?.message} /><Field label="Ширина, мм" input={<input {...register('vehicleWidth')} />} error={errors.vehicleWidth?.message} /><Field label="Высота, мм" input={<input {...register('vehicleHeight')} />} error={errors.vehicleHeight?.message} /></div>
    <div className="field-grid three"><Field label="Двери, мм" input={<input {...register('doorWidth')} />} error={errors.doorWidth?.message} /><Field label="Зазор, мм" input={<input {...register('gap')} />} error={errors.gap?.message} /><Field label="Грузоподъёмность, кг" input={<input {...register('payloadCapacityKg')} placeholder="не указана" />} error={errors.payloadCapacityKg?.message} /></div>
    <div className="section-label cargo-label">Препятствия и недоступные зоны</div>
    <div className="field-grid four"><Field label="X" input={<input {...register('obstacleX')} />} error={errors.obstacleX?.message} /><Field label="Y" input={<input {...register('obstacleY')} />} error={errors.obstacleY?.message} /><Field label="Длина" input={<input {...register('obstacleLength')} />} error={errors.obstacleLength?.message} /><Field label="Ширина" input={<input {...register('obstacleWidth')} />} error={errors.obstacleWidth?.message} /></div>
    <label className="check-field"><input type="checkbox" {...register('unavailable')} /> Есть недоступная зона</label>
    <div className="section-label cargo-label">Автомобиль и оси</div>
    <Field label="Количество осей" input={<input {...register('axleCount')} />} error={errors.axleCount?.message} />
    <div className="section-label cargo-label">Грузовая группа</div>
    <div className="preset-row">{presets.map((p, i) => <button type="button" key={p[0]} className={preset === i ? 'preset active' : 'preset'} onClick={() => applyPreset(i)}>{p[0]}</button>)}</div>
    <div className="field-grid four"><Field label="Длина, мм" input={<input {...register('cargoLength')} />} error={errors.cargoLength?.message} /><Field label="Ширина, мм" input={<input {...register('cargoWidth')} />} error={errors.cargoWidth?.message} /><Field label="Высота, мм" input={<input {...register('cargoHeight')} />} error={errors.cargoHeight?.message} /><Field label="Вес, кг" input={<input {...register('palletWeight')} />} error={errors.palletWeight?.message} /></div>
    <div className="field-grid two"><Field label="Количество" input={<input {...register('quantity')} />} error={errors.quantity?.message} /><label className="check-field inline"><input type="checkbox" {...register('rotatable')} /> Можно поворачивать</label></div>
    {recognized && <div className="recognized">Распознано: <b>{recognized}</b><button type="button" onClick={() => setRecognized('')}>×</button></div>}
    <button type="submit" className="primary-button">Построить план <span>→</span></button>
    <button type="button" onClick={() => void speak()} className="voice-button">{listening ? '● Слушаю…' : '⌁ Описать голосом'}</button>
  </form>
}

function Assistant() {
  const loadDemo = useLoadPlanStore(s => s.loadDemo), loading = useLoadPlanStore(s => s.isLoading), error = useLoadPlanStore(s => s.error)
  return <aside className="assistant-panel"><div className="brand"><span className="brand-mark">✦</span><span>AI LOAD PLANNER</span></div><div className="assistant-copy"><span className="eyebrow">ПЕРВЫЙ ЗАПУСК</span><h1>Расскажите, какая у вас машина и какой груз.</h1><p>Сначала покажем схему размещения. Непроверенные параметры явно отмечены.</p></div><button onClick={() => void loadDemo()} disabled={loading} className="demo-button"><span className="play">▶</span>{loading ? 'Загружаем…' : 'Попробовать пример'}</button><div className="or"><span />или<span /></div><div className="manual-hint">Ввести вручную</div><PlanForm />{error && <div className="error-box">{error}</div>}<footer>Этап 1 · frontend · mock AI / speech / solver</footer></aside>
}

function Visualizer() {
  const { plan, calculations, selectedPallet, setSelectedPallet } = useLoadPlanStore()
  if (!plan) return <main className="visualizer empty"><div className="empty-art">▱ ▱</div><h2>Схема загрузки появится здесь</h2><p>Нажмите «Попробовать пример» или заполните параметры вручную.</p></main>
  const selected = plan.pallets.find(p => p.id === selectedPallet)
  return <main className="visualizer"><header className="visual-header"><div><span className="eyebrow">ПЛАН ЗАГРУЗКИ</span><h2>Кузов · {plan.vehicleLength} × {plan.vehicleWidth} × {plan.vehicleHeight} мм</h2></div><div className="header-stat"><b>{plan.pallets.length}/10</b><span>паллет</span></div></header><section className="canvas-wrap"><svg viewBox="-500 -280 7000 2800" role="img" aria-label="Вид сверху на кузов с паллетами" className="truck-svg"><defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#dbe5ea" strokeWidth="5" /></pattern></defs><text x="3000" y="-135" textAnchor="middle" className="dimension">6 000 мм</text><path d="M0 -80h6000" className="dimension-line" /><text x="-330" y="1100" textAnchor="middle" transform="rotate(-90 -330 1100)" className="dimension">2 050 мм</text><rect x="0" y="0" width="6000" height="2050" rx="28" fill="url(#grid)" className="truck-body" /><rect x="0" y="0" width="230" height="2050" fill="#d9e4e8" /><path d="M0 150h140 M0 1900h140" className="door" /><text x="115" y="1030" transform="rotate(-90 115 1030)" className="door-label">ДВЕРИ</text>{plan.obstacles.map(o => <g key={o.id}><rect x={o.x} y={o.y} width={o.length} height={o.width} rx="24" className="obstacle" /><text x={o.x + o.length / 2} y={o.y + o.width / 2} textAnchor="middle" className="obstacle-label">{o.label}</text></g>)}{plan.pallets.map(p => <g key={p.id} onClick={() => setSelectedPallet(p.id)} className="pallet-group"><rect x={p.x} y={p.y} width={p.length} height={p.width} rx="18" className={selectedPallet === p.id ? 'pallet selected' : 'pallet'} /><text x={p.x + p.length / 2} y={p.y + p.width / 2 + 70} textAnchor="middle" className="pallet-number">{p.id}</text></g>)}</svg></section><section className="bottom-info"><div className="selected-card"><span className="mini-pallet">▦</span><div><span className="eyebrow">ВЫБРАНА ПАЛЛЕТА</span><b>EUR #{selected?.id} <small>· {selected?.weight} кг</small></b></div></div><div className="summary"><span className="summary-title">ПРОВЕРКИ · ЭТАП 1</span>{calculations.map(c => <div className="check" key={c.id}><span className={`dot ${statusClass[c.status]}`} /><div><b>{c.label}</b><small>{c.note}</small></div><strong>{c.value}</strong><em className={statusClass[c.status]}>{statusText[c.status]}</em></div>)}</div></section><div className="mode-note">2D схема · 3D — скоро</div></main>
}

function App() {
  const [tab, setTab] = useState<'assistant' | 'visual'>('assistant')
  return <div className="app-shell"><div className="mobile-tabs"><button onClick={() => setTab('assistant')} className={tab === 'assistant' ? 'active' : ''}>Ассистент</button><button onClick={() => setTab('visual')} className={tab === 'visual' ? 'active' : ''}>Схема</button></div><div className={`desktop-panel ${tab === 'assistant' ? 'mobile-show' : ''}`}><Assistant /></div><div className={`desktop-panel ${tab === 'visual' ? 'mobile-show' : ''}`}><Visualizer /></div></div>
}
export default App