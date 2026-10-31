/** With the flag off (the default) Privy sign-in does not exist: 404, and no accounts get made. */
import { describe, expect, it } from 'vitest'
import request from 'supertest'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const app = createApp()

describe('Privy sign-in when it is switched off', () => {
  it('answers 404 on both routes and the policy advertises only Xaman', async () => {
    const body = { accessToken: 'x'.repeat(30), identityToken: 'y'.repeat(30), publicKey: 'z'.repeat(66), username: 'privyoffnobody' }
    expect((await request(app).post('/api/auth/privy').send(body)).status).toBe(404)
    expect((await request(app).post('/api/auth/privy/claim').send(body)).status).toBe(404)
    expect(await prisma.user.count({ where: { username: 'privyoffnobody' } })).toBe(0)

    const policy = await request(app).get('/api/policy')
    expect(policy.body.signers).toEqual(['xaman'])
    expect(policy.body.privyAppId).toBeUndefined()
  })
})
