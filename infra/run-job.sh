#!/usr/bin/env bash
# Runs one execution of a manual Container Apps Job and waits for it (specs/011 contracts/deploy-pipeline.md).
#   infra/run-job.sh <resource group> <job> [command args...]
# With a command, the execution overrides the job's command. A start override replaces the whole template
# (research R18), so this copies the job's current template and changes only the first container's command:
# the image and the Key Vault-backed env come along unchanged. Prints the execution's logs and exits 0 only
# when the execution Succeeded. Starting a job grants its credentials, so only the deploy identity
# (job-regression) and the operators' group (job-operator) may run this.
set -euo pipefail

RG="$1"
JOB="$2"
shift 2
TIMEOUT_S="${JOB_TIMEOUT_S:-900}"

if [[ $# -gt 0 ]]; then
  OVERRIDE=$(mktemp)
  trap 'rm -f "$OVERRIDE"' EXIT
  CMD=$(printf '%s\n' "$@" | jq -R . | jq -s .)
  az containerapp job show -n "$JOB" -g "$RG" --query properties.template -o json \
    | jq --argjson cmd "$CMD" '{containers: [.containers[0] | .command = $cmd | del(.args)]}' > "$OVERRIDE"
  EXEC=$(az containerapp job start -n "$JOB" -g "$RG" --yaml "$OVERRIDE" --query name -o tsv)
else
  EXEC=$(az containerapp job start -n "$JOB" -g "$RG" --query name -o tsv)
fi
echo "run-job: $JOB execution $EXEC started" >&2

STATUS="Running"
DEADLINE=$(( $(date +%s) + TIMEOUT_S ))
while [[ "$STATUS" == "Running" || "$STATUS" == "Processing" || "$STATUS" == "Unknown" || -z "$STATUS" ]]; do
  if (( $(date +%s) > DEADLINE )); then
    echo "run-job: $JOB execution $EXEC timed out after ${TIMEOUT_S}s" >&2
    exit 1
  fi
  sleep 10
  STATUS=$(az containerapp job execution show -n "$JOB" -g "$RG" --job-execution-name "$EXEC" --query properties.status -o tsv 2>/dev/null || echo Unknown)
done

CONTAINER=$(az containerapp job show -n "$JOB" -g "$RG" --query "properties.template.containers[0].name" -o tsv)
az containerapp job logs show -n "$JOB" -g "$RG" --execution "$EXEC" --container "$CONTAINER" --format text 2>/dev/null || true
echo "run-job: $JOB execution $EXEC $STATUS" >&2
[[ "$STATUS" == "Succeeded" ]]
