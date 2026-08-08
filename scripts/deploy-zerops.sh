#!/usr/bin/env bash
# Import (if needed) + push Ephemera control plane to Zerops.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${ZEROPS_API_TOKEN:?set ZEROPS_API_TOKEN}"
: "${ZEROPS_ORG_ID:?set ZEROPS_ORG_ID}"

zcli login "$ZEROPS_API_TOKEN"

if [[ -z "${EPHEMERA_APP_PROJECT_ID:-}" ]]; then
  echo "EPHEMERA_APP_PROJECT_ID unset — importing new project from zerops-project-import.yml"
  zcli project project-import "$ROOT/zerops-project-import.yml" --org-id "$ZEROPS_ORG_ID"
  echo "Set EPHEMERA_APP_PROJECT_ID to the new project id, configure secrets, then re-run."
  exit 0
fi

echo "Pushing api/worker/web → project $EPHEMERA_APP_PROJECT_ID"
zcli push api -P "$EPHEMERA_APP_PROJECT_ID" --working-dir "$ROOT"
zcli push worker -P "$EPHEMERA_APP_PROJECT_ID" --working-dir "$ROOT"
zcli push web -P "$EPHEMERA_APP_PROJECT_ID" --working-dir "$ROOT"
echo "Done. Configure GitHub webhook → https://api-<host>-3000.prg1.zerops.app/webhooks/github"
