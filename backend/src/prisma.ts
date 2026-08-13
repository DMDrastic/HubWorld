// Imported FIRST, and the order is load-bearing rather than stylistic.
//
// ESM evaluates imports in source order, and `@prisma/client` loads a `.env`
// of its own at import time. With it above this line, Prisma's DATABASE_URL
// wins before `env.ts` has run dotenv — so a process pointed at another
// environment via DOTENV_CONFIG_PATH silently talks to the DEFAULT database
// while every other variable comes from the file it was given.
//
// That produced a confident wrong answer, not an error: `payload:report`
// printed a MAINNET header while querying the dev database, and reported no
// payloads after a real event had just run through it.
import { env } from './env.js'
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
