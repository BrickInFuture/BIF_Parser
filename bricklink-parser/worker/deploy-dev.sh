# Deploy warm price-refresh worker to Cloud Run (dev).
#   export REFRESH_WORKER_TOKEN='...'
#   ./scripts/bricklink-parser/worker/deploy-dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PROJECT="${DEV_PROJECT_ID:-brickinfuture-306f1}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-bricklink-refresh}"
TOKEN="${REFRESH_WORKER_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "Set REFRESH_WORKER_TOKEN (shared secret for API → worker)."
  exit 1
fi

cd "$ROOT"

gcloud artifacts repositories describe bif --location="$REGION" --project="$PROJECT" >/dev/null 2>&1 \
  || gcloud artifacts repositories create bif \
       --repository-format=docker \
       --location="$REGION" \
       --project="$PROJECT" \
       --quiet

gcloud builds submit \
  --project="$PROJECT" \
  --config=scripts/bricklink-parser/worker/cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_SERVICE=${SERVICE},_REFRESH_WORKER_TOKEN=${TOKEN}" \
  --timeout=1800

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
echo ""
echo "Worker URL: $URL"
echo "Set Cloud Functions env:"
echo "  PRICE_REFRESH_WORKER_URL=$URL"
echo "  PRICE_REFRESH_WORKER_TOKEN=<same token>"
echo "Then: npm run deploy:functions:dev"
