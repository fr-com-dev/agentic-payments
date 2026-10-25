#!/usr/bin/env bash
# GitHub setup for the deploy workflows (specs/011 contracts/deploy-pipeline.md; quickstart §4 prerequisites).
# Reads env/infra.env, creates the GitHub environment the deploy jobs run in, and sets the repository secrets the
# workflows read. All six are identifiers or public addresses, kept as secrets so the logs mask them:
# - AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID: the deploy app's OIDC sign-in;
# - AGENT_API_CLIENT_ID: the API app's client ID, the AUTH_AUDIENCE infra/entra-app.sh prints. Leave it empty
#   until quickstart §4 step 0 has run, then run this again;
# - SELLER_PAY_TO, PAYER_ADDRESS: public addresses.
# The workflows read no GitHub variables. The file may hold only these keys, GITHUB_REPO and GITHUB_ENVIRONMENT.
# Any other key, or a value of the wrong shape (a private key pasted as an address), fails the whole file before
# anything is sent: credentials live only in the Key Vaults, never in GitHub. Values reach `gh` on stdin, never
# in its arguments, and are never printed. Re-running updates the same environment and secrets.
#
# usage: infra/github-setup.sh [--env-file env/infra.env] [--dry-run]
# needs: gh, signed in with admin rights on the repository (creating an environment needs them).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/env/infra.env"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The secrets deploy-layer.yml declares, in the order they are set.
SECRETS=(AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID AGENT_API_CLIENT_ID SELLER_PAY_TO PAYER_ADDRESS)
KEYS=(GITHUB_REPO GITHUB_ENVIRONMENT "${SECRETS[@]}")
GUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
ADDRESS='^0x[0-9a-fA-F]{40}$'
DQ='^"(.*)"$'
SQ="^'(.*)'$"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "no $ENV_FILE: copy env/infra.env.example to it and fill it in" >&2
  exit 2
fi

# Values are kept in CFG_<key>, so nothing exported by the caller's shell counts and gh never inherits them.
for k in "${KEYS[@]}"; do printf -v "CFG_$k" '%s' ""; done
get() { local v="CFG_$1"; printf '%s' "${!v}"; }

ERRORS=()
SEEN=" "
n=0
# Parsed, never sourced: the file is data. Error messages name the line and key, never the value.
while IFS= read -r line || [[ -n "$line" ]]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
  if [[ ! "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
    ERRORS+=("line $n is not KEY=VALUE")
    continue
  fi
  key="${BASH_REMATCH[2]}"
  value="${BASH_REMATCH[3]}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" =~ $DQ || "$value" =~ $SQ ]]; then value="${BASH_REMATCH[1]}"; fi
  if [[ " ${KEYS[*]} " != *" $key "* ]]; then
    if [[ "$key" =~ PRIVATE_KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|API_KEY ]]; then
      ERRORS+=("line $n: $key is a credential; it goes only into a Key Vault (quickstart §4 step 3), never into GitHub")
    else
      ERRORS+=("line $n: unknown key $key (allowed: ${KEYS[*]})")
    fi
    continue
  fi
  if [[ "$SEEN" == *" $key "* ]]; then
    ERRORS+=("line $n: $key is set twice")
    continue
  fi
  SEEN+="$key "
  printf -v "CFG_$key" '%s' "$value"
done < "$ENV_FILE"

# Checks one key against a pattern; an empty value is an error unless the key is optional.
check() {
  local key="$1" pattern="$2" what="$3" optional="${4:-}" value
  value="$(get "$key")"
  if [[ -z "$value" ]]; then
    [[ -n "$optional" ]] || ERRORS+=("$key is empty")
  elif [[ ! "$value" =~ $pattern ]]; then
    ERRORS+=("$key is not $what")
  fi
}
check GITHUB_REPO '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' "owner/name"
check GITHUB_ENVIRONMENT '^[A-Za-z0-9_-]+$' "an environment name"
for k in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do check "$k" "$GUID" "a GUID"; done
check AGENT_API_CLIENT_ID "$GUID" "a GUID" optional
for k in SELLER_PAY_TO PAYER_ADDRESS; do
  check "$k" "$ADDRESS" "a 0x address of 40 hex digits (a 64-digit value is a private key: never put one here)"
done
ENVIRONMENT="$(get GITHUB_ENVIRONMENT)"
if [[ -n "$ENVIRONMENT" && ! -f "$ROOT/infra/params/$ENVIRONMENT.bicepparam" ]]; then
  ERRORS+=("GITHUB_ENVIRONMENT $ENVIRONMENT has no infra/params/$ENVIRONMENT.bicepparam, so the workflows can't deploy it")
fi
if [[ -n "$(get AGENT_API_CLIENT_ID)" && "$(get AGENT_API_CLIENT_ID)" == "$(get AZURE_CLIENT_ID)" ]]; then
  ERRORS+=("AGENT_API_CLIENT_ID equals AZURE_CLIENT_ID: it is the API app's client ID (entra-app.sh's AUTH_AUDIENCE), not the deploy app's")
fi

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "$ENV_FILE: nothing was sent to GitHub" >&2
  for e in "${ERRORS[@]}"; do echo "  $e" >&2; done
  exit 2
fi

REPO="$(get GITHUB_REPO)"
if $DRY_RUN; then
  echo "dry run: would create the environment $ENVIRONMENT in $REPO"
  for name in "${SECRETS[@]}"; do
    if [[ -n "$(get "$name")" ]]; then echo "dry run: would set the secret $name"; fi
  done
  exit 0
fi

gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" --silent
echo "environment $ENVIRONMENT: ready in $REPO"
for name in "${SECRETS[@]}"; do
  value="$(get "$name")"
  if [[ -z "$value" ]]; then
    echo "secret $name: skipped, empty (run infra/entra-app.sh, add its AUTH_AUDIENCE, then run this again)"
    continue
  fi
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO"
  echo "secret $name: set"
done

# No workflow reads any other secret (T-E2E-AZ), so one here is unused, or a credential that shouldn't be in GitHub.
EXTRA=""
while IFS= read -r s; do
  if [[ -n "$s" && " ${SECRETS[*]} " != *" $s "* ]]; then EXTRA+=" $s"; fi
done <<< "$(gh secret list --repo "$REPO" --json name --jq '.[].name')"
if [[ -n "$EXTRA" ]]; then
  echo "warning: $REPO also holds the secrets$EXTRA, which no workflow reads. If one is a credential, delete it" \
    "(gh secret delete <name> --repo $REPO): credentials live only in the Key Vaults." >&2
fi
