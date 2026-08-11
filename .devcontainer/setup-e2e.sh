#!/usr/bin/env bash
#
# Playwright's browsers. Separate from post-create because they are a few
# hundred megabytes and most sessions never run e2e.
#
# BOTH engines are needed, and it is easy to install only one. The suite has two
# projects: `desktop` uses Desktop Chrome, and `mobile` uses the iPhone 13
# descriptor — which defaults to WEBKIT, not a narrow Chromium window. Device
# emulation is the whole reason the suite is Playwright rather than Cypress
# (`cy.viewport()` is CSS-only), so installing chromium alone would silently
# skip the half that justified the choice.
set -euo pipefail

cd "$(dirname "$0")/../frontend"

echo "==> system libraries (needs root; the devcontainer user has sudo)"
sudo npx playwright install-deps chromium webkit

echo "==> browsers"
npx playwright install chromium webkit

cat <<'EOF'

  Ready.  npm run e2e        (frontend/)
          npm run e2e:ui     pick and watch individual specs

  The suite starts its own backend in STUB MODE on its own ports (4100/5273),
  so it cannot fight the dev servers and costs nothing against the Xaman quota.

EOF
