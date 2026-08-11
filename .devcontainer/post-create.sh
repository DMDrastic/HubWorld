#!/usr/bin/env bash
#
# Bring a fresh container to the state a working Mac checkout is in.
#
# Kept FAST on purpose: this runs before you can type anything, so it does the
# work that is required and skips the work that is merely sometimes wanted.
# Playwright's browsers are the main omission — they are a few hundred megabytes
# and most sessions never run e2e. Install them with:
#
#   bash .devcontainer/setup-e2e.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> postgresql-client"
# Not in the base image, and worth having for two reasons: the test-database
# fallback below shells out to `createdb`, and you will want `psql` the first
# time you need to look at a row rather than guess at one.
# DEBIAN_FRONTEND is set because postCreate has no controlling tty, and without
# it apt prints a wall of debconf warnings that look like failures and are not.
if ! command -v psql >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client >/dev/null
fi

echo "==> backend: install"
# `npm ci` rather than `npm install`: the lockfile is the definition, and CI
# installs the same way. engine-strict is on, so a wrong Node fails here loudly
# instead of somewhere confusing inside tsx later.
(cd backend && npm ci)

echo "==> backend: prisma client"
(cd backend && npx prisma generate)

echo "==> backend: migrate the dev database"
# `deploy`, not `dev`. `prisma migrate dev` refuses to run without an
# interactive terminal, which this is not — the same constraint CLAUDE.md
# documents for agent shells and CI. From your own terminal in this container,
# `npm run prisma:migrate` works normally.
(cd backend && npx prisma migrate deploy)

echo "==> backend: the separate test database"
# Tests get their own database so a running dev server's settlement sweep cannot
# delete fixtures mid-run. That was measured, not theorised: full-suite failures
# went from 2/10 with the server running to 0/6 after.
#
# It matters MORE here than on the Mac, not less: a container is one small box
# where the dev servers and a test run are far likelier to be going at once.
(cd backend && npm run db:test:setup)

echo "==> frontend: install"
(cd frontend && npm ci)

cat <<'EOF'

  HubWorld is ready.

    backend/   npm run dev     http://localhost:4000
    frontend/  npm run dev     http://localhost:5173

  Both must be running. Sign-in uses STUB MODE — there are no Xaman
  credentials here and there should not be. Instead of scanning a QR:

    POST /api/auth/signin            -> { uuid }
    POST /api/auth/signin/simulate   -> pretend the user signed

  Seed something to look at:

    cd backend && npm run demo:seed

  Not available without credentials: real signing, the broker (selling and
  settlement answer 503), and anything pointed at production.

  End-to-end tests need browsers first:  bash .devcontainer/setup-e2e.sh

EOF
