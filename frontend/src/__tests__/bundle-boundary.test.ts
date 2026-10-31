// @vitest-environment node
/**
 * The email wallet must stay out of the main bundle.
 *
 * Measured, not assumed: when `SignStep` imported the review module at the top, the XRPL codec
 * rode into the entry chunk and roughly doubled it (1.16 MB, against 0.52 MB once it loaded on
 * demand). Nothing fails when that happens; the app works and is just heavier for everyone. So the
 * rule is pinned against the real source: Privy and the XRPL library are imported only by the files
 * that exist to hold them, and everything else reaches them through a dynamic import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === '__tests__') return []
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** Static value imports of `from '<spec>'` (a `import type` is erased and costs nothing). */
function staticImports(text: string): string[] {
  return [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
}

describe('what may import the heavy libraries', () => {
  it('only the Privy runtime imports the Privy SDK', () => {
    const offenders = sources(SRC)
      .filter((f) => relative(SRC, f) !== join('components', 'PrivyRuntime.tsx'))
      .filter((f) => staticImports(readFileSync(f, 'utf8')).some((s) => s.startsWith('@privy-io')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })

  it('only the review module imports the XRPL library', () => {
    const offenders = sources(SRC)
      .filter((f) => relative(SRC, f) !== join('lib', 'sign-review.ts'))
      .filter((f) => staticImports(readFileSync(f, 'utf8')).some((s) => s === 'xrpl'))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })

  it('nothing but the loader reaches the review module with a static import', () => {
    const offenders = sources(SRC)
      .filter((f) => !['sign-review.ts', 'sign-review-loader.ts'].includes(relative(join(SRC, 'lib'), f)))
      .filter((f) => staticImports(readFileSync(f, 'utf8')).some((s) => s === '@/lib/sign-review'))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })

  it('the Privy runtime is only ever pulled in lazily', () => {
    const offenders = sources(SRC)
      .filter((f) => staticImports(readFileSync(f, 'utf8')).some((s) => s === '@/components/PrivyRuntime'))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })
})
