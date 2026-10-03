import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { SpeechService } from './services'
import { useLoadPlanStore } from './store'
import type { CheckStatus, LoadPlan } from './types'
import './styles.css'

const formSchema = z.object({ vehicleLength: z.coerce.number().min(1000), vehicleWidth: z.coerce.number().min(500), vehicleHeight: z.coerce.number().min(500), quantity: z.coerce.number().int().min(1).max(20), palletWeight: z.coerce.number().min(1) })
type FormValues = z.infer<typeof formSchema>

const statusClass: Record<CheckStatus, string> = { CHECKED: 'status-ok', VIOLATION: 'status-bad', NOT_CHECKED: 'status-idle' }
const statusText: Record<CheckStatus, string> = { CHECKED: 'ПРОВЕРЕНО', VIOLATION: 'НАРУШЕНИЕ', NOT_CHECKED: 'НЕ ПРОВЕРЕНО' }

function PlanForm() {
  const setPlan = useLoadPlanStore((state) => state.setPlan)
  const [listening, setListening] = useState(false)
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { vehicleLength: 6000, vehicleWidth: 2050, vehicleHeight: 2200, quantity: 10, palletWeight: 450 } })
  const onSubmit = (values: FormValues) => {
    const plan: LoadPlan = { vehicleLength: values.vehicleLength, vehicleWidth: values.vehicleWidth, vehicleHeight: values.vehicleHeight, pallets: Array.from({ length: values.quantity }, (_, index) => ({ id: index + 1, length: 1200, width: 800, weight: values.palletWeight, x: 280 + (index % 5) * 1220, y: index < 5 ? 180 : 1070 })) }
    void setPlan(plan)
  }
  const speak = async () => { setListening(true); await SpeechService.listen(); setListening(false) }
  return <form onSubmit={handleSubmit(onSubmit)} className="plan-form">
    <div className="section-label">Параметры кузова</div>
    <div className="field-grid"><Field label="Длина, мм" error={errors.vehicleLength?.message} input={<input {...register('vehicleLength')} />} /><Field label="Ширина, мм" error={errors.vehicleWidth?.message} input={<input {...register('vehicleWidth')} />} /><Field label="Высота, мм" error={errors.vehicleHeight?.message} input={<input {...register('vehicleHeight')} />} /></div>
    <div className="section-label cargo-label">Груз</div>
    <div className="cargo-card"><div><b>EUR паллета</b><small>1 200 × 800 мм</small></div><span className="pallet-icon">▦</span></div>
    <div className="field-grid two"><Field label="Количество" error={errors.quantity?.message} input={<input {...register('quantity')} />} /><Field label="Вес одной, кг" error={errors.palletWeight?.message} input={<input {...register('palletWeight')} />} /></div>
    <button type="submit" className="primary-button">Построить план <span>→</span></button>
    <button type="button" onClick={() => void speak()} className="voice-button">{listening ? '● Слушаю…' : '⌁ Описать голосом'}</button>
  </form>
}
function Field({ label, input, error }: { label: string; input: React.ReactNode; error?: string }) { return <label className="field"><span>{label}</span>{input}{error && <em>{error}</em>}</label> }

function Assistant() {
  const loadDemo = useLoadPlanStore((state) => state.loadDemo); const isLoading = useLoadPlanStore((state) => state.isLoading)
  return <aside className="assistant-panel"><div className="brand"><span className="brand-mark">✦</span><span>LOADWISE</span><i>AI LOAD PLANNER</i></div><div className="assistant-copy"><span className="eyebrow">НОВЫЙ РЕЙС</span><h1>Спланируем<br />загрузку.</h1><p>Укажите груз и кузов — подготовим понятную схему размещения.</p></div><button onClick={() => void loadDemo()} disabled={isLoading} className="demo-button"><span className="play">▶</span>{isLoading ? 'Создаём план…' : 'Открыть демо'}</button><div className="or"><span />или<span /></div><PlanForm /><footer>Этап 1 · планировщик загрузки</footer></aside>
}

function Visualizer() {
  const { plan, calculations, selectedPallet, setSelectedPallet } = useLoadPlanStore()
  if (!plan) return <main className="visualizer empty"><div className="empty-art"><span>▱</span><span>▱</span><span>▱</span></div><h2>Схема загрузки появится здесь</h2><p>Откройте демо или заполните параметры вручную,<br />чтобы построить план.</p></main>
  const selected = plan.pallets.find((p) => p.id === selectedPallet)
  return <main className="visualizer"><header className="visual-header"><div><span className="eyebrow">ПЛАН ЗАГРУЗКИ</span><h2>Рефрижератор <b>·</b> {plan.vehicleLength} × {plan.vehicleWidth} × {plan.vehicleHeight} мм</h2></div><div className="header-stat"><b>{plan.pallets.length}</b><span>палл.</span></div></header><section className="canvas-wrap"><svg viewBox="-500 -280 7000 2800" role="img" aria-label="Вид сверху на кузов с паллетами" className="truck-svg"><defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#dbe5ea" strokeWidth="5" /></pattern></defs><text x="3000" y="-135" textAnchor="middle" className="dimension">6 000 мм</text><path d="M0 -80h6000m0 0-35-28m35 28-35 28M0 -80l35-28M0-80l35 28" className="dimension-line" /><text x="-330" y="1100" textAnchor="middle" transform="rotate(-90 -330 1100)" className="dimension">2 050 мм</text><rect x="0" y="0" width="6000" height="2050" rx="28" fill="url(#grid)" className="truck-body" /><rect x="0" y="0" width="230" height="2050" fill="#d9e4e8" /><path d="M0 150 h140 M0 1900 h140" className="door" /><text x="115" y="1030" transform="rotate(-90 115 1030)" className="door-label">ДВЕРИ</text><rect x="5230" y="700" width="420" height="540" rx="24" className="obstacle" /><text x="5440" y="1000" textAnchor="middle" className="obstacle-label">ОХЛАДИТЕЛЬ</text>{plan.pallets.map((pallet) => <g key={pallet.id} onClick={() => setSelectedPallet(pallet.id)} className="pallet-group"><rect x={pallet.x} y={pallet.y} width={pallet.length} height={pallet.width} rx="18" className={selectedPallet === pallet.id ? 'pallet selected' : 'pallet'} /><path d={`M${pallet.x + 26} ${pallet.y + 65}h${pallet.length - 52}M${pallet.x + 26} ${pallet.y + pallet.width - 65}h${pallet.length - 52}`} className="pallet-lines" /><text x={pallet.x + 600} y={pallet.y + 450} textAnchor="middle" className="pallet-number">{pallet.id}</text></g>)}</svg></section><section className="bottom-info"><div className="selected-card"><span className="mini-pallet">▦</span><div><span className="eyebrow">ВЫБРАНА ПАЛЛЕТА</span><b>EUR #{selected?.id} <small>· {selected?.weight} кг</small></b></div></div><div className="summary"><span className="summary-title">ПРОВЕРКИ</span>{calculations.map((item) => <div className="check" key={item.label}><span className={`dot ${statusClass[item.status]}`} /><div><b>{item.label}</b><small>{item.note}</small></div><strong>{item.value}</strong><em className={statusClass[item.status]}>{statusText[item.status]}</em></div>)}</div></section></main>
}

function App() { const [tab, setTab] = useState<'assistant' | 'visual'>('assistant'); return <div className="app-shell"><div className="mobile-tabs"><button onClick={() => setTab('assistant')} className={tab === 'assistant' ? 'active' : ''}>Ассистент</button><button onClick={() => setTab('visual')} className={tab === 'visual' ? 'active' : ''}>Схема</button></div><div className={`desktop-panel ${tab === 'assistant' ? 'mobile-show' : ''}`}><Assistant /></div><div className={`desktop-panel ${tab === 'visual' ? 'mobile-show' : ''}`}><Visualizer /></div></div> }
export default App
