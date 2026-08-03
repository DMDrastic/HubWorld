import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

/**
 * The dev port and the API it proxies to are overridable, so a second stack can
 * run alongside the one you are working in. End-to-end tests need their own
 * backend — in STUB mode, on its own database — and must not fight the dev
 * servers for :5173 and :4000 or silently talk to the wrong one.
 *
 * Defaults are unchanged, so `npm run dev` behaves exactly as before.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:4000'
const DEV_PORT = Number(process.env.VITE_PORT ?? 5173)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: DEV_PORT,
    // Proxying /api keeps the browser same-origin in dev, so no CORS preflight.
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      // ws:true is required — without it the upgrade request is proxied as
      // plain HTTP and Socket.IO silently falls back to long polling, which is
      // the very thing the websocket is here to replace.
      '/socket.io': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
