import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The look of a form field: a soft plate with a hairline edge that brightens on
 * hover, and a violet ring on focus. Shared with native selects and textareas so a
 * panel never mixes a styled input with a default-looking select beside it.
 *
 * Tall enough to touch (44px on a phone, 40px with a pointer), and 16px on a
 * phone, because iOS zooms the page into any field set smaller than that.
 */
export const fieldClass =
  "w-full min-w-0 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-3.5 text-base text-foreground transition-colors outline-none placeholder:text-muted-foreground hover:border-[var(--surface-border-hover)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:text-sm"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClass,
        "h-11 py-1 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground sm:h-10",
        className
      )}
      {...props}
    />
  )
}

export { Input }
