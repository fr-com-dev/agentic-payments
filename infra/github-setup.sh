#!/usr/bin/env bash
# GitHub setup for .github/workflows/deploy.yml (specs/011 contracts/deploy-pipeline.md; quickstart §4 step 1).
# Creates the GitHub environment the deploy job runs in, named with the repository in
# infra/pre-deploy.<environment>.bicepparam (githubRepository, githubEnvironment), which Bicep compiles: the deploy
# app's federated credential trusts that job only. First it checks that GitHub signs the repository's jobs with the
# subject the credential trusts: GitHub's immutable subject, repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>
# (otherwise azure/login fails with AADSTS700213). The workflow reads no GitHub secret or variable: its sign-in and
# target come from infra/main.<environment>.bicepparam. So a secret found in the repository or the environment is
# reported, never used: no workflow reads it, and a credential there should be deleted.
#
# usage: infra/github-setup.sh [--environment dev] [--dry-run]
# needs: gh, signed in with admin rights on the repository (creating an environment needs them); az with Bicep
# (az bicep install), and jq. az needs no sign-in here.
set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="dev"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PARAMS="$INFRA/pre-deploy.$ENVIRONMENT.bicepparam"
if [[ ! "$ENVIRONMENT" =~ ^[a-z0-9]+$ || ! -f "$PARAMS" ]]; then
  echo "no infra/pre-deploy.$ENVIRONMENT.bicepparam: the environment $ENVIRONMENT isn't set up" >&2
  exit 2
fi
# The values Bicep compiles from the parameter file: what pre-deploy.bicep itself gets.
if ! VALUES=$(az bicep build-params --file "$PARAMS" --stdout --only-show-errors | jq '.parametersJson | fromjson | .parameters | map_values(.value)'); then
  echo "Bicep can't compile $PARAMS: nothing was sent to GitHub" >&2
  exit 2
fi
value() { jq -er --arg p "$1" '.[$p] | strings' <<< "$VALUES" || { echo "$PARAMS has no string parameter $1" >&2; return 2; }; }
REPO=$(value githubRepository)
GH_ENV=$(value githubEnvironment)
OWNER_ID=$(value githubOwnerId)
REPO_ID=$(value githubRepositoryId)
ERRORS=()
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || ERRORS+=("githubRepository $REPO is not owner/name")
[[ "$GH_ENV" == "$ENVIRONMENT" ]] || ERRORS+=("githubEnvironment $GH_ENV is not $ENVIRONMENT: deploy.yml's job runs in the GitHub environment named like the deploy environment")
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "$PARAMS: nothing was sent to GitHub" >&2
  for e in "${ERRORS[@]}"; do echo "  $e" >&2; done
  exit 2
fi

# The subject prefix GitHub puts in this repository's OIDC tokens (a read), and the one the deploy app trusts.
TRUSTED="repo:${REPO%%/*}@$OWNER_ID/${REPO#*/}@$REPO_ID"
SIGNED=$(gh api "repos/$REPO/actions/oidc/customization/sub" | jq -r --arg repo "$REPO" \
  'if .use_default != true then "a custom claim template" elif .use_immutable_subject != true then "repo:\($repo)" else .sub_claim_prefix end')
if [[ "$SIGNED" != "$TRUSTED" ]]; then
  echo "GitHub signs $REPO's jobs as $SIGNED:…, but the deploy app's federated credential trusts $TRUSTED:…: nothing was sent to GitHub" >&2
  echo "  set githubOwnerId and githubRepositoryId in $PARAMS (gh api repos/$REPO --jq '.owner.id, .id')," >&2
  echo "  keep the repository's immutable OIDC subject on, and deploy pre-deploy.bicep again" >&2
  exit 2
fi

if $DRY_RUN; then
  echo "dry run: would create the environment $GH_ENV in $REPO"
  exit 0
fi

gh api --method PUT "repos/$REPO/environments/$GH_ENV" --silent
echo "environment $GH_ENV: ready in $REPO"

# No workflow reads a secret, so one here is unused, or a credential that shouldn't be in GitHub.
LEFTOVER=$( { gh secret list --repo "$REPO" --json name --jq '.[].name'; gh secret list --repo "$REPO" --env "$GH_ENV" --json name --jq '.[].name'; } | paste -sd' ' -)
if [[ -n "$LEFTOVER" ]]; then
  echo "warning: $REPO holds the secrets $LEFTOVER, which no workflow reads. Delete them" \
    "(gh secret delete <name> --repo $REPO [--env $GH_ENV]): deploy.yml takes every value from infra/main.$ENVIRONMENT.bicepparam." >&2
fi
