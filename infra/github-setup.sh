#!/usr/bin/env bash
# GitHub setup for the pipelines, .github/workflows/deploy-*.yml, whose shared deploy.yml job runs in the environment
# (specs/011 contracts/deploy-pipeline.md; quickstart §4 step 1).
# Creates the GitHub environment the deploy job runs in, named with the repository in
# infra/pre-deploy.<environment>.bicepparam (githubRepository, githubEnvironment), which Bicep compiles. The deploy
# app's federated credential trusts that job only. First it checks that GitHub signs the repository's jobs with the
# subject the credential trusts: GitHub's immutable subject, repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>
# (otherwise azure/login fails with AADSTS700213).
# A credential trusts any job that names its environment, whatever the branch, so the environment gets a deployment
# branch policy (Phase 3): it lets jobs from the branch main and from the pipelines' own tags (deploy-<unit>-*, each
# .github/workflows/deploy-*.yml's push trigger) only. A job from any other branch or tag waits for nothing and gets
# no token: GitHub refuses it. The script creates the policies that are missing, never deletes one, and reports one it
# didn't make. It keeps the environment's reviewers and wait timer as they are. GitHub's API can't name a reviewer
# without their user ID, so it reminds you to add required reviewers by hand. No workflow reads a GitHub secret or
# variable: the deploy workflows' sign-in and target come from infra/main.<environment>.bicepparam, and (SPEC 1.26)
# the Auth0 tenant is planned and applied on the operator's host (scripts/auth0-tenant.sh), with its Management API
# credential and Terraform's variables there. So a secret found in the repository or the deploy environment is
# reported, never used, and so is the GitHub environment auth0-<environment> that earlier versions made for the Auth0
# pipeline (with that credential): a credential there should be deleted.
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

# The refs whose jobs may run in the environment, as type:pattern (GitHub matches a pattern like a file name: * stops
# at /). The deploy pipelines run by hand from main or on their own tag, deploy-<unit>-*. T-E2E-AZ
# (test/github-setup.test.ts) checks the tags against the pipelines' push triggers.
DEPLOY_REFS=("branch:main" "tag:deploy-infra-*" "tag:deploy-l1-*" "tag:deploy-l2-*" "tag:deploy-l3-*" "tag:deploy-operator-*" "tag:deploy-portal-*" "tag:deploy-seller-*")
refs() { local r list=""; for r in "$@"; do list+="${list:+, }the ${r%%:*} ${r#*:}"; done; echo "$list"; }

if $DRY_RUN; then
  echo "dry run: would create the environment $GH_ENV in $REPO, open to $(refs "${DEPLOY_REFS[@]}") only"
  exit 0
fi

# Creates the environment, or turns on custom deployment branch policies in one that exists, then adds the missing
# policies. The PUT carries the environment's reviewers and wait timer as GitHub has them, so it never drops one.
protect() {
  local env="$1" current body held ref
  local -a others
  shift
  current=$(gh api "repos/$REPO/environments/$env" 2>/dev/null) || current='{}'
  if [[ $(jq -r '.deployment_branch_policy.custom_branch_policies // false' <<< "$current") != "true" ]]; then
    body=$(jq -c '{
        wait_timer: ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer] | first // 0),
        prevent_self_review: ([.protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review] | first // false),
        reviewers: [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | {type, id: .reviewer.id}],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
      }' <<< "$current")
    gh api --method PUT "repos/$REPO/environments/$env" --input - --silent <<< "$body"
  fi
  held=$(gh api --paginate "repos/$REPO/environments/$env/deployment-branch-policies" | jq -r '.branch_policies[] | "\(.type // "branch"):\(.name)"')
  for ref in "$@"; do
    if grep -qxF "$ref" <<< "$held"; then continue; fi
    gh api --method POST "repos/$REPO/environments/$env/deployment-branch-policies" -f "name=${ref#*:}" -f "type=${ref%%:*}" --silent
  done
  others=()
  while IFS= read -r ref; do
    if [[ -n "$ref" ]]; then others+=("$ref"); fi
  done < <(grep -vxF -f <(printf '%s\n' "$@") <<< "$held" || true)
  if [[ ${#others[@]} -gt 0 ]]; then
    echo "warning: the environment $env also lets jobs run from $(refs "${others[@]}"), which this script didn't make: delete each one" \
      "you don't want (Settings > Environments > $env > Deployment branches and tags)." >&2
  fi
}

protect "$GH_ENV" "${DEPLOY_REFS[@]}"
echo "environment $GH_ENV: ready in $REPO, open to $(refs "${DEPLOY_REFS[@]}") only. Give it required reviewers by hand" \
  "(Settings > Environments > $GH_ENV > Required reviewers): a run's deployment then waits for one of them."

# No workflow reads a secret of the repository or of the deploy environment, so one there is unused, or a credential
# that shouldn't be in GitHub. SPEC 1.26: neither does any workflow use the Auth0 environment earlier versions made.
if gh api "repos/$REPO/environments/auth0-$ENVIRONMENT" --silent 2>/dev/null; then
  echo "warning: $REPO still has the GitHub environment auth0-$ENVIRONMENT, with the Auth0 Management API credential that" \
    "earlier versions' provision-auth0.yml read. No workflow uses it since SPEC 1.26 (the tenant is applied with" \
    "scripts/auth0-tenant.sh on the operator's host): delete it (gh api --method DELETE repos/$REPO/environments/auth0-$ENVIRONMENT)." >&2
fi
LEFTOVER=$( { gh secret list --repo "$REPO" --json name --jq '.[].name'; gh secret list --repo "$REPO" --env "$GH_ENV" --json name --jq '.[].name'; } | paste -sd' ' -)
if [[ -n "$LEFTOVER" ]]; then
  echo "warning: $REPO holds the secrets $LEFTOVER, which no workflow reads. Delete them" \
    "(gh secret delete <name> --repo $REPO [--env $GH_ENV]): deploy.yml takes every value from infra/main.$ENVIRONMENT.bicepparam." >&2
fi
