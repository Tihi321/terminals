import type { JSX } from 'react'

/** Keyboard shortcut rendered as key caps, e.g. "Ctrl+Shift+T". */
export function Keys({ combo }: { combo: string }): JSX.Element {
  return (
    <span className="keys">
      {combo.split('+').map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  )
}
