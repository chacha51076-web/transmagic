export type CheckStatus = 'CHECKED' | 'VIOLATION' | 'NOT_CHECKED' | 'CALCULATED'

export interface Obstacle { id: string; x: number; y: number; length: number; width: number; label: string; weight?: number; height?: number; blocksFloor?: boolean }
export interface DoorGap { id: string; x: number; y: number; length: number; width: number; label: string }
export interface Axle { id: string; position: number; capacityKg: number; source?: 'AUTO' | 'FIXED' }
export interface CargoGroup {
  id: string
  name: string
  length: number
  width: number
  height: number
  weight: number
  count: number
  rotatable: boolean
  stackable: boolean
}
export interface Pallet {
  id: number
  length: number
  width: number
  height: number
  weight: number
  x: number
  y: number
  rotatable: boolean
  stackable: boolean
}
export interface FixedCooler {
  width: number
  projection: number
  height: number
}

export interface LoadPlan {
  vehicleLength: number
  vehicleWidth: number
  vehicleHeight: number
  fixedCooler: FixedCooler
  payloadCapacityKg?: number
  doors: DoorGap[]
  gaps: DoorGap[]
  obstacles: Obstacle[]
  unavailableZones: Obstacle[]
  axles: Axle[]
  cargoGroups: CargoGroup[]
  pallets: Pallet[]
}
export interface Calculation {
  id: string
  label: string
  value: string
  status: CheckStatus
  note: string
}