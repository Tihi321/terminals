import type { TerminalsApi } from '../shared/types'

declare global {
  interface Window {
    api: TerminalsApi
  }
}

export {}
