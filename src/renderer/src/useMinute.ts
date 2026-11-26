import { useSyncExternalStore } from 'react'

/** Shared once-a-minute clock for relative ages ("2m ago"). Only components that call useMinute re-render on the tick. */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let now = Date.now()

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of [...listeners]) l()
    }, 60_000)
  }
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Epoch ms of the latest minute tick (and of the first subscription). */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, () => now)
}
