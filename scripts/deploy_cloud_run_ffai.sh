#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-${1:-}}"
REGION="${REGION:-australia-southeast1}"
SERVICE="${SERVICE:-ccc-ffai-runner}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://customcode.connectio.com.au}"
MEMORY="${MEMORY:-4Gi}"
CONCURRENCY="${CONCURRENCY:-1}"
# A deploy now compiles the generated classes before pushing them, so a request
# covers `flutter pub get` plus `flutter analyze` on top of the DSL run. Cloud
# Run's 300s default would cut that off on a cold instance.
TIMEOUT="${TIMEOUT:-900}"

if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "PROJECT_ID is required. Pass it as the first arg or set PROJECT_ID." >&2
  exit 64
fi

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source cloud-run/ffai-runner \
  --allow-unauthenticated \
  --memory "$MEMORY" \
  --concurrency "$CONCURRENCY" \
  --timeout "$TIMEOUT" \
  --set-env-vars "ALLOWED_ORIGIN=$ALLOWED_ORIGIN"

echo
echo "Set VITE_FLUTTERFLOW_DSL_DEPLOY_ENDPOINT to:"
gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.url)' | sed 's#$#/deployCustomClasses#'
