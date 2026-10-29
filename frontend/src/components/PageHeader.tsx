/**
 * The title of a page, and the one control that belongs to it.
 *
 * Every destination used to open with its own copy of the same three lines (an
 * `h1`, a muted paragraph, a wrapper), each a few pixels different from the next.
 * One component means the page title is set the same way everywhere, and gives a
 * page's primary control — Events' Upcoming/Past switch — a fixed place to sit:
 * on the title's line, at the far edge, where a thumb or a cursor already is.
 *
 * `aside` wraps under the title on a narrow screen rather than shrinking it.
 */
export function PageHeader({
  title,
  description,
  aside,
}: {
  title: string
  description?: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-10 pb-8 sm:pt-12 sm:pb-10">
      <div className="min-w-0">
        <h1 className="font-heading text-4xl leading-[1.05] font-semibold tracking-[-0.03em] text-balance sm:text-[2.75rem]">
          {title}
        </h1>
        {description && (
          <p className="text-muted-foreground mt-3 max-w-xl leading-relaxed text-pretty">
            {description}
          </p>
        )}
      </div>
      {aside}
    </header>
  )
}
