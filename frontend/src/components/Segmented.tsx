/**
 * A two-or-three way switch between views of the same list.
 *
 * Built as tabs, not as a row of buttons, because that is what it is: each choice
 * swaps the contents of one panel. It matters for more than correctness. A page
 * that counts its controls by role (the Events tests assert "only a live auction
 * is a button") must not find a view switch among them, and a screen reader is
 * told "tab 1 of 2, selected", which a pair of unlabelled buttons never says.
 *
 * Arrow keys move between the choices and only the selected one is in the tab
 * order, so the whole switch is a single stop — the pattern tabs have always had.
 */
import { useRef } from 'react'

export type SegmentedOption<T extends string> = { value: T; label: string }

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  idBase,
  panelId,
}: {
  /** Names the switch for assistive tech ("Show events"). */
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  /** Prefix for the tab ids, so the panel can say which tab labels it. */
  idBase: string
  panelId: string
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>())

  function move(from: number, step: number) {
    const next = options[(from + step + options.length) % options.length]!
    onChange(next.value)
    refs.current.get(next.value)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="surface inline-flex gap-0.5 rounded-xl p-0.5"
    >
      {options.map((o, i) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              if (el) refs.current.set(o.value, el)
              else refs.current.delete(o.value)
            }}
            type="button"
            role="tab"
            id={`${idBase}-${o.value}`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault()
                move(i, 1)
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                move(i, -1)
              }
            }}
            className={`focus-visible:ring-ring min-h-11 rounded-[0.65rem] sm:min-h-10 px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none ${
              selected
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
