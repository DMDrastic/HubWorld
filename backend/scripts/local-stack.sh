#!/bin/zsh
# A private HubWorld for trying things out: this checkout's backend and frontend, against the REAL test network, on ports that do
# not collide with an ordinary `npm run dev` (API 4001, web 5175).
#
#   scripts/local-stack.sh start     start both, in the background (logs in ~/.hubworld-local/)
#   scripts/local-stack.sh stop      stop both (only the processes this script started)
#   scripts/local-stack.sh status    what is running, and the backend's health
#   scripts/local-stack.sh event     create an event you can buy a ticket to: 5 real tickets at 10 XRP
#                                    (--tickets N --price X to change)
#
# Run from backend/. What it reads, none of it in the repo:
#   backend/.env (or $HUBWORLD_BASE_ENV)   the usual local settings; its DATABASE_URL must be a LOCAL database
#   ~/.hubworld-privy.env                  PRIVY_APP_ID, for "Continue with email"
#   ~/.hubworld-local-delegate.env         a throwaway test-network delegate, created by the first `event`
#
# It has its OWN database, `hubworld_local` (created and migrated by `start`), so its events and purchases never appear in the
# database an ordinary `npm run dev` uses. `LEDGER=real` points it at the real test network, so purchases really settle; Xaman stays
# pretend (no Xaman credentials), so use "Continue with email". The browser address must be one Privy allows (localhost:5175 and
# localhost:5173 are on the list; another port needs adding in the Privy dashboard).
set -eu

API_PORT=${API_PORT:-4001}
WEB_PORT=${WEB_PORT:-5175}
HERE=${0:A:h}
BACKEND=${HERE:h}
FRONTEND=${BACKEND:h}/frontend
STATE=$HOME/.hubworld-local
BASE_ENV=${HUBWORLD_BASE_ENV:-$BACKEND/.env}
PRIVY_ENV=$HOME/.hubworld-privy.env
DELEGATE_ENV=$HOME/.hubworld-local-delegate.env
mkdir -p "$STATE"

die() { print -u2 -- "local-stack: $*"; exit 1; }

check_env() {
  [[ -f $BASE_ENV ]] || die "no $BASE_ENV (copy backend/.env.example, or set HUBWORLD_BASE_ENV)"
  # Refuse anything but a local database: this stack writes test rows. Checked without printing the URL (it may hold a password).
  grep -E '^DATABASE_URL=' "$BASE_ENV" | grep -Eq '@(localhost|127\.0\.0\.1)[:/]' ||
    die "DATABASE_URL in $BASE_ENV is not a local database; refusing to start"
}

# The environment both the server and the event script run with. Secrets are loaded into the process, never printed.
with_env() {
  (
    set -a
    [[ -f $PRIVY_ENV ]] && . "$PRIVY_ENV"
    [[ -f $DELEGATE_ENV ]] && . "$DELEGATE_ENV"
    set +a
    export DOTENV_CONFIG_PATH=$BASE_ENV XRPL_NETWORK=testnet PORT=$API_PORT
    export SIGNERS=xaman,privy FEE_MODEL=v2 PRICE_FEED=on XRP_USD_CENTS=${XRP_USD_CENTS:-125} CLAIMS_ENABLED=false
    # The real test network, without pretending to have Xaman credentials.
    export LEDGER=real
    # Its own database (written by `setup_db`); it overrides the dev one in backend/.env.
    [[ -f $STATE/db.env ]] && { set -a; . "$STATE/db.env"; set +a }
    cd "$BACKEND"
    "$@"
  )
}

# Create and migrate this stack's own database, and record its URL in $STATE/db.env (mode 600; the URL is never printed).
setup_db() {
  (
    set -a; . "$BASE_ENV"; set +a
    cd "$BACKEND"
    npx tsx scripts/setup-local-db.ts --emit "$STATE/db.env" | grep -v '^$' || die "could not prepare the local database"
  )
}

running() { [[ -f $STATE/$1.pid ]] && kill -0 "$(<$STATE/$1.pid)" 2>/dev/null }

# Stops exactly the process this script started and its children. Never by name: a name also matches someone else's `npm run dev`.
stop_one() {
  local name=$1
  if running "$name"; then
    local pid=$(<$STATE/$name.pid)
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    print -- "stopped $name"
  fi
  rm -f "$STATE/$name.pid"
}

wait_for() {
  local url=$1 label=$2
  for _ in {1..60}; do
    curl -s -m 2 -o /dev/null "$url" && { print -- "$label: $url"; return 0 }
    sleep 1
  done
  die "$label did not come up; see $STATE/*.log"
}

case ${1:-} in
  start)
    check_env
    [[ -f $PRIVY_ENV ]] || print -- "note: no $PRIVY_ENV, so 'Continue with email' will not appear"
    [[ -f $DELEGATE_ENV ]] || print -- "note: no delegate yet; run '$0 event' once to create one, then restart"
    lsof -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1 && ! running backend && die "port $API_PORT is in use by something else"
    lsof -iTCP:$WEB_PORT -sTCP:LISTEN >/dev/null 2>&1 && ! running frontend && die "port $WEB_PORT is in use by something else"
    setup_db
    if ! running backend; then
      with_env nohup npx tsx watch src/server.ts >"$STATE/backend.log" 2>&1 &
      print -- $! >"$STATE/backend.pid"
    fi
    if ! running frontend; then
      (cd "$FRONTEND" && VITE_API_TARGET=http://localhost:$API_PORT VITE_PORT=$WEB_PORT nohup npx vite --port $WEB_PORT --host localhost >"$STATE/frontend.log" 2>&1 &
        print -- $! >"$STATE/frontend.pid")
    fi
    wait_for "http://localhost:$API_PORT/api/health" "api"
    wait_for "http://localhost:$WEB_PORT/" "open"
    ;;
  stop)
    stop_one frontend
    stop_one backend
    ;;
  status)
    for n in backend frontend; do running $n && print -- "$n: running (pid $(<$STATE/$n.pid))" || print -- "$n: stopped"; done
    curl -s -m 3 "http://localhost:$API_PORT/api/health" | python3 -c '
import sys, json
d = json.load(sys.stdin)
p = d.get("price", {})
g = d.get("delegate", {})
print("api: " + d["status"] + " on " + d["network"] + "; XRP price " + str(p.get("usdPerXrp", "-")) + " (" + str(p.get("status")) + "); delegate " + str(g.get("mode")) + " " + str(g.get("status", "")))
' 2>/dev/null ||
      print -- "api: not answering"
    ;;
  event)
    check_env
    setup_db
    shift
    with_env env DELEGATE_ENV_FILE="$DELEGATE_ENV" npx tsx scripts/local-box-office-demo.ts "$@"
    running backend && print -- "\nIf this was the first event (a new delegate), restart so the server signs as it: $0 stop && $0 start"
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
