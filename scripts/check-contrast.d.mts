export const TOKENS_CSS: string
export const FAMILIES: string[]
export const SCHEMES: string[]
export const MIN_RATIO: number
export const PAIRS: [string, string][]
export interface ContrastRow { variant: string; pair: string; ratio: number; ok: boolean }
export function parseColor(value: string): [number, number, number, number]
export function contrastRatio(a: number[], b: number[]): number
export function checkContrast(css?: string): { rows: ContrastRow[]; failures: ContrastRow[] }
