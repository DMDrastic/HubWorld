# HubWorld — one image, one process, one origin.
#
# The frontend and backend are built separately and then SHIPPED TOGETHER, with
# Express serving the built app alongside the API. That is not packaging
# convenience; the app requires it. The frontend calls a relative `/api`, opens
# its socket with a bare `io()`, and authenticates with a `SameSite=Lax` cookie
# that a browser stops sending on XHR the moment the API is a different site.
# Two hosts would break sign-in, and the fix for that is one origin — not
# `SameSite=None`, which reintroduces the CSRF hole `Lax` closes.
#
# Deliberately host-agnostic: no Fly/Render/Railway-specific anything, so the
# choice of host stays a deployment decision rather than a code one.

# ---- 1. Frontend -------------------------------------------------------------
# Node 22: Vite 8 needs >= 20.19, and .npmrc sets engine-strict.
FROM node:22-alpine AS web

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc* ./
# `npm ci` over `npm install` — it installs the lockfile exactly rather than
# resolving fresh, so the image matches what was tested.
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---- 2. Backend build --------------------------------------------------------
FROM node:22-alpine AS api

WORKDIR /api
COPY backend/package.json backend/package-lock.json backend/.npmrc* ./
RUN npm ci

COPY backend/ ./
# The Prisma client is generated code — it must exist before tsc, and again in
# the runtime stage, because it is platform-specific.
RUN npm run prisma:generate && npm run build

# ---- 3. Runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init gives us a real PID 1, so SIGTERM reaches Node and the XRPL
# websocket gets closed on shutdown instead of the container being killed.
RUN apk add --no-cache dumb-init

WORKDIR /app
ENV NODE_ENV=production

COPY backend/package.json backend/package-lock.json backend/.npmrc* ./
RUN npm ci --omit=dev

# Prisma's schema and generated client are runtime dependencies: `migrate deploy`
# reads the schema, and the query engine binary is fetched per-platform.
COPY backend/prisma ./prisma
RUN npx prisma generate

COPY --from=api /api/dist ./dist
COPY --from=web /web/dist ./public

# Where Express looks for the built app. Absent, it serves the API only.
ENV WEB_DIST=/app/public

# Which commit this image was built from, reported by GET /api/health.
#
# Baked in at build time rather than read at runtime, so the answer describes
# the code in the image and cannot drift from it. Declared here, after every
# COPY and RUN, because its value changes on every single build: anything below
# an ARG is rebuilt when that ARG changes, and below this point there is only
# metadata (EXPOSE, CMD). Move it higher and each deploy re-runs `npm ci`.
#
# Render injects RENDER_GIT_COMMIT into builds automatically, so
# `--build-arg COMMIT_SHA=$RENDER_GIT_COMMIT` is all a host needs — and if it
# passes nothing, the backend falls back to RENDER_GIT_COMMIT at runtime and
# then to 'unknown'. Never required.
ARG COMMIT_SHA=""
ENV COMMIT_SHA=${COMMIT_SHA}

# Informational; the host decides the real port and PORT is read from env.
EXPOSE 4000

# Run migrations before serving. A container that starts against an un-migrated
# database answers every request with a Prisma error, which is worse than
# failing to start.
CMD ["dumb-init", "sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
