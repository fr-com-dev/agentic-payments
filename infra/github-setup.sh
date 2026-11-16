#!/usr/bin/env bash
# GitHub setup for the pipelines, .github/workflows/deploy-*.yml, whose shared deploy.yml job runs in the environment
# (specs/011 contracts/deploy-pipeline.md; quickstart §4 step 1).
# Creates the two GitHub environments the jobs run in, named with the repository in
# infra/pre-deploy.<environment>.bicepparam (githubRepository, githubEnvironment, githubAuth0Environment), which Bicep
# compiles: the deploy job's, and the Auth0 job's (.github/workflows/provision-auth0.yml), auth0-<environment>. The
# deploy app's two federated credentials trust those jobs only. First it checks that GitHub signs the repository's jobs with the
# subject the credential trusts: GitHub's immutable subject, repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>
# (otherwise azure/login fails with AADSTS700213).
# A credential trusts any job that names its environment, whatever the branch, so each environment gets a deployment
# branch policy (Phase 3): the deploy environment lets jobs from the branch main and from the pipelines' own tags
# (deploy-<unit>-*, each .github/workflows/deploy-*.yml's push trigger) only, and the Auth0 environment from main
# only (provision-auth0.yml runs by hand). A job from any other branch or tag waits for nothing and gets no token: GitHub
# refuses it. The script creates the policies that are missing, never deletes one, and reports one it didn't make.
# It keeps an environment's reviewers and wait timer as they are. GitHub's API can't name a reviewer without their
# user ID, so it reminds you to add required reviewers to both environments by hand. The deploy workflows read no GitHub secret or variable: their
# sign-in and target come from infra/main.<environment>.bicepparam. So a secret found in the repository or the deploy
# environment is reported, never used: no workflow reads it, and a credential there should be deleted. The only
# secrets and variables a workflow reads are the Auth0 environment's. Its secrets (the Auth0 Management API
# credential) are never set or read here: an administrator sets them by hand (auth0/README.md). Its variables
# (Terraform's, none a secret) are created here when missing, never changed: the three without a default as the
# placeholder REPLACE_ME, which provision-auth0.yml refuses to plan with, and the optional ones as the default of
# auth0/variables.tf (AUTH0_MACHINE_CALLER_KEYS, 016, as {}: no machine caller; AUTH0_ALLOW_SIGN_UPS as true), but
# AUTH0_LOCAL_ORIGINS, which is true for dev (the local portal and agent sign in against its tenant) and false
# elsewhere. An administrator then replaces
# the placeholders by hand. AUTH0_PORTAL_ORIGIN (013) and AUTH0_AGENT_ORIGIN (016) are not created: neither has a
# value until the portal or the agent is deployed, and a GitHub variable can't be empty. Unset, Terraform's default
# (no deployed origin) holds; an administrator sets each one then (auth0/README.md).
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
GH_AUTH0_ENV=$(value githubAuth0Environment)
OWNER_ID=$(value githubOwnerId)
REPO_ID=$(value githubRepositoryId)
ERRORS=()
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || ERRORS+=("githubRepository $REPO is not owner/name")
[[ "$GH_ENV" == "$ENVIRONMENT" ]] || ERRORS+=("githubEnvironment $GH_ENV is not $ENVIRONMENT: deploy.yml's job runs in the GitHub environment named like the deploy environment")
[[ "$GH_AUTH0_ENV" == "auth0-$ENVIRONMENT" ]] || ERRORS+=("githubAuth0Environment $GH_AUTH0_ENV is not auth0-$ENVIRONMENT: provision-auth0.yml's job runs in the GitHub environment auth0-<environment>")
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

# The refs whose jobs may run in each environment, as type:pattern (GitHub matches a pattern like a file name: * stops
# at /). The deploy pipelines run by hand from main or on their own tag, deploy-<unit>-*; the Auth0 pipeline runs by
# hand only. T-E2E-AZ (test/github-setup.test.ts) checks the tags against the pipelines' push triggers.
DEPLOY_REFS=("branch:main" "tag:deploy-infra-*" "tag:deploy-l1-*" "tag:deploy-l2-*" "tag:deploy-l3-*" "tag:deploy-operator-*" "tag:deploy-portal-*" "tag:deploy-seller-*")
AUTH0_REFS=("branch:main")
refs() { local r list=""; for r in "$@"; do list+="${list:+, }the ${r%%:*} ${r#*:}"; done; echo "$list"; }

if $DRY_RUN; then
  echo "dry run: would create the environment $GH_ENV in $REPO, open to $(refs "${DEPLOY_REFS[@]}") only"
  echo "dry run: would create the environment $GH_AUTH0_ENV in $REPO, open to $(refs "${AUTH0_REFS[@]}") only, and its missing AUTH0_* variables"
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
protect "$GH_AUTH0_ENV" "${AUTH0_REFS[@]}"
echo "environment $GH_AUTH0_ENV: ready in $REPO, open to $(refs "${AUTH0_REFS[@]}") only. Give it required reviewers, and set its secrets by hand:" \
  "gh secret set AUTH0_CLIENT_ID --repo $REPO --env $GH_AUTH0_ENV, and AUTH0_CLIENT_SECRET the same way (auth0/README.md)."

# Terraform's variables for provision-auth0.yml, as variables of the Auth0 environment. Only the missing ones are
# created: one that exists keeps its value, whatever it is. AUTH0_PORTAL_ORIGIN and AUTH0_AGENT_ORIGIN are set by
# hand, after the portal's and the agent's first deployment. The local origins are dev's only.
PLACEHOLDER="REPLACE_ME"
LOCAL_ORIGINS=false
if [[ "$ENVIRONMENT" == "dev" ]]; then LOCAL_ORIGINS=true; fi
AUTH0_VARIABLES=(
  "AUTH0_TENANT_DOMAIN=$PLACEHOLDER"
  "AUTH0_API_IDENTIFIER=$PLACEHOLDER"
  "AUTH0_CLIENT_PUBLIC_KEY=$PLACEHOLDER"
  "AUTH0_MANAGE_GUARDIAN=true"
  "AUTH0_GUARDIAN_POLICY=never"
  "AUTH0_MACHINE_CALLER_KEYS={}"
  "AUTH0_LOCAL_ORIGINS=$LOCAL_ORIGINS"
  "AUTH0_ALLOW_SIGN_UPS=true"
)
HELD=$(gh variable list --repo "$REPO" --env "$GH_AUTH0_ENV" --json name --jq '.[].name')
TO_REPLACE=()
for entry in "${AUTH0_VARIABLES[@]}"; do
  name="${entry%%=*}" value="${entry#*=}"
  if grep -qxF "$name" <<< "$HELD"; then
    echo "variable $name: already in $GH_AUTH0_ENV, kept"
    continue
  fi
  gh variable set "$name" --repo "$REPO" --env "$GH_AUTH0_ENV" --body "$value"
  echo "variable $name: created in $GH_AUTH0_ENV as $value"
  if [[ "$value" == "$PLACEHOLDER" ]]; then TO_REPLACE+=("$name"); fi
done
if [[ ${#TO_REPLACE[@]} -gt 0 ]]; then
  echo "replace the placeholders before the first run (gh variable set <name> --repo $REPO --env $GH_AUTH0_ENV): ${TO_REPLACE[*]}." \
    "provision-auth0.yml plans nothing while one is $PLACEHOLDER (auth0/README.md)."
fi

# No workflow reads a secret of the repository or of the deploy environment, so one there is unused, or a credential
# that shouldn't be in GitHub. The Auth0 environment's secrets are not listed: provision-auth0.yml reads them.
LEFTOVER=$( { gh secret list --repo "$REPO" --json name --jq '.[].name'; gh secret list --repo "$REPO" --env "$GH_ENV" --json name --jq '.[].name'; } | paste -sd' ' -)
if [[ -n "$LEFTOVER" ]]; then
  echo "warning: $REPO holds the secrets $LEFTOVER, which no workflow reads. Delete them" \
    "(gh secret delete <name> --repo $REPO [--env $GH_ENV]): deploy.yml takes every value from infra/main.$ENVIRONMENT.bicepparam." >&2
fi
