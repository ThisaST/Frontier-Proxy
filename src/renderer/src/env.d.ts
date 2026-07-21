import type { FrontierApi } from '../../shared/types'

declare global {
  interface Window { frontier: FrontierApi }
}

export {}
