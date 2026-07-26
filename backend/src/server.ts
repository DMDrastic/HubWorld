import { createApp } from './app.js'
import { env } from './env.js'
import { prisma } from './prisma.js'

const app = createApp()

const server = app.listen(env.PORT, () => {
  console.log(`backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0))
    })
  })
}
