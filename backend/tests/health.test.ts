/**
 * GET /api/health, and specifically: which build is serving?
 *
 * Nothing reported it. Confirming a deploy had actually shipped meant probing
 * an endpoint for a behaviour change and inferring the answer, which only works
 * when the release happens to change behaviour observably — and gives no answer
 * at all for a release that does not.
 *
 * The rule the tests below pin is that reporting the build must never be able
 * to STOP the build running. Health answers 200 with a database that is down;
 * it must equally answer when it does not know its own commit, and the process
 * must boot when the value is missing or empty.
 */
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { z } from 'zod'

const { createApp } = await import('../src/app.js')
const { COMMIT_SHA, env } = await import('../src/env.js')

const app = createApp()

describe('GET /api/health', () => {
  it('reports the commit and network alongside the existing fields', async () => {
    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      db: expect.stringMatching(/^(connected|unavailable)$/),
      commit: expect.any(String),
      network: expect.stringMatching(/^(testnet|devnet|mainnet)$/),
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    })
  })

  it('reports the network the process is ACTUALLY using', async () => {
    // The point of the field is answering "is this pointed at real money?"
    // without trusting a dashboard. A hardcoded 'testnet' would answer that
    // question wrongly in the one case where being wrong costs real XRP, so
    // this asserts it tracks the parsed config rather than a literal.
    const res = await request(app).get('/api/health')
    expect(res.body.network).toBe(env.XRPL_NETWORK)
  })

  it("says 'unknown' rather than omitting the field when unset", async () => {
    // The shape must not depend on configuration: a client reading `commit`
    // should never have to distinguish "absent" from "not built with one".
    // Nothing sets COMMIT_SHA in the test environment, so this is that case.
    expect(COMMIT_SHA).toBe('unknown')

    const res = await request(app).get('/api/health')
    expect(res.body).toHaveProperty('commit')
    expect(res.body.commit).toBe('unknown')
  })

  it('still answers 200, the property the whole endpoint rests on', async () => {
    // Restated here because `commit` is new and must not have introduced a way
    // for this route to fail. The UI renders a status from this response even
    // when Postgres is down; a throw would blank it instead.
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
  })
})

describe('an empty COMMIT_SHA is treated as absent', () => {
  /**
   * `ARG COMMIT_SHA=""` in the Dockerfile defines the variable as an empty
   * string rather than leaving it unset. A plain `.min(7).optional()` accepts
   * undefined but REJECTS '', and a rejected env parse calls process.exit(1) —
   * so an image built without --build-arg would refuse to boot because it did
   * not know its own name. This pins the preprocessing that prevents it.
   */
  it('parses empty to undefined instead of failing the schema', () => {
    // The same shape env.ts applies, exercised directly: the module-level parse
    // there runs once at import and cannot be re-run with different values.
    const emptyAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
      z.preprocess((v) => (v === '' ? undefined : v), schema.optional())
    const field = emptyAsAbsent(z.string().min(7))

    expect(field.safeParse('').success).toBe(true)
    expect(field.parse('')).toBeUndefined()
    expect(field.parse(undefined)).toBeUndefined()
    expect(field.parse('bf983ea1234')).toBe('bf983ea1234')

    // And the guard it replaced would indeed have failed, which is why the
    // preprocessing is load-bearing rather than decorative.
    expect(z.string().min(7).optional().safeParse('').success).toBe(false)
  })
})
