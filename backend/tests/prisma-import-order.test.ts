/**
 * `src/prisma.ts` must import `./env.js` BEFORE `@prisma/client`.
 *
 * ESM evaluates imports in source order, and `@prisma/client` loads a `.env` of
 * its own at import time. With it first, Prisma's `DATABASE_URL` is already set
 * before `env.ts` runs dotenv — so `DOTENV_CONFIG_PATH` silently fails to point
 * the database anywhere, while every OTHER variable comes from the named file.
 *
 * The result is a hybrid process that is confidently wrong rather than broken.
 * Measured during the mainnet rehearsal: `payload:report` printed a MAINNET
 * header while querying the DEV database, and reported no payloads immediately
 * after sixteen had been created. The same trap made `role:grant` report "No
 * user" for a user that plainly existed — and the same invocation with a name
 * that DID exist in the dev database would have granted a role in the wrong
 * place.
 *
 * This is asserted on the SOURCE rather than by importing the module, because
 * the tests already have DATABASE_URL set by `vitest.config.ts`, so the bug is
 * invisible from inside a running test. The property being protected is
 * textual, so the test is textual — and an import sorter that "tidies" these two
 * lines is exactly what would reintroduce it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, '../src/prisma.ts'), 'utf8')

describe('prisma module import order', () => {
  it('imports env.js before @prisma/client', () => {
    const envAt = source.indexOf("from './env.js'")
    const clientAt = source.indexOf("from '@prisma/client'")

    expect(envAt).toBeGreaterThan(-1)
    expect(clientAt).toBeGreaterThan(-1)
    expect(envAt).toBeLessThan(clientAt)
  })

  it('says why, so the order is not tidied away', () => {
    // A bare reorder with no explanation invites the next formatter to undo it.
    expect(source).toMatch(/DOTENV_CONFIG_PATH/)
  })
})
