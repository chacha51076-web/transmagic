export type CheckStatus = 'CHECKED' | 'VIOLATION' | 'NOT_CHECKED'

export interface Pallet { id: number; length: number; width: number; weight: number; x: number; y: number }
export interface LoadPlan { vehicleLength: number; vehicleWidth: number; vehicleHeight: number; pallets: Pallet[] }
export interface Calculation { label: string; value: string; status: CheckStatus; note: string }
