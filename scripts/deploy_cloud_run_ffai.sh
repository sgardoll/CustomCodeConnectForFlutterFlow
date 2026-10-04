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
# Keep one instance always on. Most of a deploy's 103-215s on a cold start is
# the FlutterFlow AI SDK download and a fresh `flutter pub get` after `ai init`;
# a warm instance does that once at container boot instead of per request. The
# tradeoff is a small always-on instance cost for a much shorter deploy.
MIN_INSTANCES="${MIN_INSTANCES:-1}"
# Reported by the runner's /healthz, so which revision is live - and therefore
# whether a merged fix actually shipped - is answerable in seconds instead of
# guessed at. This is exactly how a merged-but-never-deployed runner fix went
# unnoticed for months. Taken from the build's own checkout; empty (never
# wrong) if git is unavailable.
RUNNER_GIT_SHA="${RUNNER_GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || true)}"

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
  --min-instances "$MIN_INSTANCES" \
  --timeout "$TIMEOUT" \
  --set-env-vars "ALLOWED_ORIGIN=$ALLOWED_ORIGIN,RUNNER_GIT_SHA=$RUNNER_GIT_SHA"

echo
echo "Deployed revision reports RUNNER_GIT_SHA=${RUNNER_GIT_SHA:-<unset>}"

echo
echo "Set VITE_FLUTTERFLOW_DSL_DEPLOY_ENDPOINT to:"
gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.url)' | sed 's#$#/deployCustomClasses#'
