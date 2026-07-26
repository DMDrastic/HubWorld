import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf, usernameSchema } from '../schemas.js'

export const usersRouter = Router()

const UsernameParams = z.object({ username: usernameSchema })

/**
 * GET /api/users/:username
 *
 * The @handle → XRPL address lookup. This is the indirection that keeps raw
 * r-addresses off the screen: everything user-facing resolves through here.
 */
usersRouter.get('/users/:username', async (req, res) => {
  const parsed = UsernameParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid username', details: issuesOf(parsed.error) })
    return
  }

  const user = await prisma.user.findUnique({
    where: { username: parsed.data.username },
    select: {
      username: true,
      displayName: true,
      xrplAddress: true,
      createdAt: true,
      _count: { select: { ticketsOwned: true } },
    },
  })

  if (!user) {
    res.status(404).json({ error: `No user @${parsed.data.username}` })
    return
  }

  const { _count, ...rest } = user
  res.json({ ...rest, ticketsOwned: _count.ticketsOwned })
})
