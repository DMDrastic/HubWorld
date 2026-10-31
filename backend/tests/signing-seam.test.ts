/**
 * The signing seam: routes ask `signing.ts` for a signer, never `xaman.ts`.
 *
 * Why this is pinned: adding an embedded-wallet signer must be a new implementation behind
 * `SigningProvider`, not an edit to eleven routes. That holds only while no route reaches
 * past the seam, and nothing else would notice one that does, because it would still work.
 * This reads the real source files, so it cannot drift from what ships.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signing, providerFor } from '../src/signing.js'
import { xaman, asStub } from '../src/xaman.js'

const SRC = join(__dirname, '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })
}

// Xaman-specific error classes may still be imported from xaman.ts (payload-store maps a
// rate limit); the CLIENT and the shared helpers may not.
const CLIENT_NAMES = /\b(xaman|tryGetPayload|asStub|SIGNIN_TTL_MINUTES)\b/

describe('the signing seam', () => {
  it('has exactly one provider today, and it is the counted Xaman client', () => {
    expect(signing).toBe(xaman)
    expect(providerFor()).toBe(signing)
    // `asStub` unwraps the counting wrapper, so the e2e simulate endpoint still works.
    expect(asStub(signing)).not.toBeNull()
  })

  it('is the only way a route reaches the signer', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file)
      if (rel === 'xaman.ts' || rel === 'signing.ts') continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[./]+\/xaman\.js'/g)) {
        const names = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, ''))
        if (names.some((n) => CLIENT_NAMES.test(n))) offenders.push(`${rel}: ${m[1]!.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
