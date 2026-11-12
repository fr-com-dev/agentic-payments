#!/usr/bin/env bash
# Deletes everything pre-deploy.bicep, main.bicep and infra/github-setup.sh created for one environment (specs/011
# quickstart §6), in this order:
# 1. the GitHub environment the deploy job runs in;
# 2. the deploy app's role assignments anywhere in the subscription. Azure keeps a deleted principal's role
#    assignments, so they go before the app does;
# 3. the resource group: the apps, jobs, environments, vaults, registry, storage, Foundry, identities, network and
#    logs, with the role assignments inside it;
# 4. the app registrations, the API app (app-l1-…, with its Agent.Run assignments) and the deploy app (app-deploy-…,
#    with its federated credential), and the operators' group (grp-op-…).
# The tenant, subscription, names and GitHub repository come from infra/pre-deploy.<environment>.bicepparam, which
# Bicep compiles; the resource group must also be the one infra/main.<environment>.bicepparam deploys to.
#
# Deleted vaults, Foundry accounts and app registrations stay soft-deleted, and their names stay taken. With --purge
# the Foundry account and the app registrations are purged afterwards. The vaults can't be: purge protection keeps
# them, with their secrets, for 90 days. Deploying the environment again before then needs them recovered first.
# The operators' group is a security group: deleting it is final. It leaves the subscription's resource providers,
# NetworkWatcherRG (which Azure shares across deployments) and the subscription's deployment history.
#
# usage: infra/cleanup.sh [--environment dev] [--dry-run] [--purge] [--yes]
#   --dry-run  only reads: prints what would be deleted, and deletes nothing (even with --yes)
#   --purge    also purge what soft-delete keeps, so the names can be reused at once
#   --yes      skip the confirmation (typing the resource group's name)
# needs: az with Bicep (az bicep install), signed in to the parameter file's tenant with rights to delete the resource
# group, role assignments, app registrations and the group; gh signed in with admin rights on the repository; jq.
set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="dev"
DRY_RUN=false
PURGE=false
YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --purge) PURGE=true; shift ;;
    --yes) YES=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

GRAPH="https://graph.microsoft.com/v1.0"
TAB=$'\t'
refuse() {
  echo "nothing was deleted" >&2
  for e in "$@"; do echo "  $e" >&2; done
  exit 2
}

PARAMS="$INFRA/pre-deploy.$ENVIRONMENT.bicepparam"
MAIN_PARAMS="$INFRA/main.$ENVIRONMENT.bicepparam"
[[ "$ENVIRONMENT" =~ ^[a-z0-9]+$ && -f "$PARAMS" && -f "$MAIN_PARAMS" ]] || refuse "no infra/pre-deploy.$ENVIRONMENT.bicepparam and infra/main.$ENVIRONMENT.bicepparam: the environment $ENVIRONMENT isn't set up"
# The values Bicep compiles from a parameter file: what its deployment itself gets.
compiled() { az bicep build-params --file "$1" --stdout --only-show-errors | jq '.parametersJson | fromjson | .parameters | map_values(.value)'; }
VALUES=$(compiled "$PARAMS") || refuse "Bicep can't compile $PARAMS"
MAIN_VALUES=$(compiled "$MAIN_PARAMS") || refuse "Bicep can't compile $MAIN_PARAMS"
MAIN_RG=$(jq -r '.names.resourceGroup // empty' <<< "$MAIN_VALUES")
value() { jq -er --arg p "$1" 'getpath($p | split(".")) | strings' <<< "$VALUES" || refuse "$PARAMS has no string parameter $1"; }
TENANT=$(value tenantId)
SUB=$(value subscriptionId)
LOCATION=$(value location)
RG=$(value names.resourceGroup)
APP_L1=$(value names.apiApp)
APP_DEPLOY=$(value names.deployApp)
GRP_OP=$(value names.operators)
REPO=$(value githubRepository)
GH_ENV=$(value githubEnvironment)
[[ "$RG" == "$MAIN_RG" ]] || refuse "pre-deploy.$ENVIRONMENT.bicepparam's resource group $RG is not $MAIN_RG, the one main.$ENVIRONMENT.bicepparam deploys to"

SIGNED_IN=$(az account show --query tenantId -o tsv)
[[ "$SIGNED_IN" == "$TENANT" ]] || refuse "az is signed in to the tenant $SIGNED_IN, not $TENANT (az login --tenant $TENANT)"

# ---- What exists (reads only) ---------------------------------------------------------------------------------
GH_ENV_EXISTS=false
if gh api "repos/$REPO/environments/$GH_ENV" --silent 2>/dev/null; then GH_ENV_EXISTS=true; fi
GH_SECRETS=$(gh secret list --repo "$REPO" --json name --jq '.[].name' | paste -sd' ' -)

# App registrations, as appId<TAB>object id<TAB>name, and the group, as id<TAB>name. Found by standard names only.
APPS=()
for name in "$APP_L1" "$APP_DEPLOY"; do
  FOUND=$(az ad app list --filter "displayName eq '$name'" --query "[].[appId,id,displayName]" -o tsv)
  while IFS= read -r a; do [[ -n "$a" ]] && APPS+=("$a"); done <<< "$FOUND"
done
GROUP=$(az ad group list --filter "displayName eq '$GRP_OP'" --query "[].[id,displayName]" -o tsv)

# The deploy app's role assignments, as id<TAB>role<TAB>scope.
ROLES=()
for a in ${APPS[@]+"${APPS[@]}"}; do
  IFS="$TAB" read -r appid _ name <<< "$a"
  [[ "$name" == "$APP_DEPLOY" ]] || continue
  SP=$(az ad sp list --filter "appId eq '$appid'" --query "[0].id" -o tsv)
  [[ -n "$SP" ]] || continue
  FOUND=$(az role assignment list --all --assignee "$SP" --subscription "$SUB" --query "[].[id,roleDefinitionName,scope]" -o tsv)
  while IFS= read -r r; do [[ -n "$r" ]] && ROLES+=("$r"); done <<< "$FOUND"
done

# The resource group, and the Foundry accounts in it (name<TAB>location), purged after the group with --purge.
GROUP_FOUND=false
GROUP_INFO=""
ACCOUNTS=()
if [[ "$(az group exists --name "$RG" --subscription "$SUB")" == "true" ]]; then
  GROUP_FOUND=true
  count=$(az resource list -g "$RG" --subscription "$SUB" --query "length(@)" -o tsv)
  vaults=$(az keyvault list -g "$RG" --subscription "$SUB" --query "[].name" -o tsv | paste -sd' ' -)
  GROUP_INFO="$count resources${vaults:+, with the vaults $vaults}"
  FOUND=$(az cognitiveservices account list -g "$RG" --subscription "$SUB" --query "[].[name,location]" -o tsv)
  while IFS= read -r a; do [[ -n "$a" ]] && ACCOUNTS+=("$a"); done <<< "$FOUND"
fi

# What an earlier run left soft-deleted: this group's Foundry accounts, and these app registrations.
in_our_group() {
  local lower
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  [[ "$lower" == *"/resourcegroups/$RG/"* ]]
}
SOFT_ACCOUNTS=()
FOUND=$(az cognitiveservices account list-deleted --subscription "$SUB" --query "[].[name,location,id]" -o tsv)
while IFS="$TAB" read -r name location id; do
  if [[ -z "$name" ]] || ! in_our_group "$id"; then continue; fi
  SOFT_ACCOUNTS+=("$name$TAB$location")
done <<< "$FOUND"
SOFT_APPS=()
FOUND=$(az rest --method GET --uri "$GRAPH/directory/deletedItems/microsoft.graph.application?\$select=id,appId,displayName&\$top=999" \
  --query "value[].[id,appId,displayName]" -o tsv)
while IFS="$TAB" read -r id _ name; do
  if [[ -n "$id" && ( "$name" == "$APP_L1" || "$name" == "$APP_DEPLOY" ) ]]; then SOFT_APPS+=("$id$TAB$name"); fi
done <<< "$FOUND"

# ---- The plan --------------------------------------------------------------------------------------------------
echo "clean-up of $ENVIRONMENT ($LOCATION) in subscription $SUB, tenant $TENANT:"
TODO=0
if $GH_ENV_EXISTS; then echo "  GitHub $REPO: delete the environment $GH_ENV"; TODO=1; fi
for r in ${ROLES[@]+"${ROLES[@]}"}; do
  IFS="$TAB" read -r _ role scope <<< "$r"
  echo "  role assignment of $APP_DEPLOY: $role on $scope"
  TODO=1
done
if $GROUP_FOUND; then echo "  resource group $RG: $GROUP_INFO"; TODO=1; fi
for a in ${APPS[@]+"${APPS[@]}"}; do
  IFS="$TAB" read -r appid _ name <<< "$a"
  echo "  app registration $name ($appid)"
  TODO=1
done
if [[ -n "$GROUP" ]]; then echo "  group ${GROUP#*"$TAB"} (${GROUP%%"$TAB"*}), for good: a security group isn't soft-deleted"; TODO=1; fi
if $PURGE; then
  for a in ${ACCOUNTS[@]+"${ACCOUNTS[@]}"} ${SOFT_ACCOUNTS[@]+"${SOFT_ACCOUNTS[@]}"}; do
    echo "  purge the Foundry account ${a%%"$TAB"*}"; TODO=1
  done
  for a in ${APPS[@]+"${APPS[@]}"}; do echo "  purge the app registration ${a##*"$TAB"}"; done
  for a in ${SOFT_APPS[@]+"${SOFT_APPS[@]}"}; do echo "  purge the deleted app registration ${a##*"$TAB"}"; TODO=1; done
fi
if [[ -n "$GH_SECRETS" ]]; then echo "  kept: the GitHub secrets $GH_SECRETS, which no workflow reads (delete them by hand if they are yours)"; fi

if [[ $TODO -eq 0 ]]; then
  echo "nothing to clean up"
  exit 0
fi
if $DRY_RUN; then
  echo "dry run: nothing was deleted"
  exit 0
fi
if ! $YES; then
  printf 'Type %s to delete all of this: ' "$RG" >&2
  answer=""
  read -r answer || true
  [[ "$answer" == "$RG" ]] || { echo "not confirmed: nothing was deleted" >&2; exit 1; }
fi

# ---- Deletion --------------------------------------------------------------------------------------------------
if $GH_ENV_EXISTS; then
  gh api --method DELETE "repos/$REPO/environments/$GH_ENV" --silent
  echo "deleted the GitHub environment $GH_ENV"
fi
if [[ ${#ROLES[@]} -gt 0 ]]; then
  IDS=()
  for r in "${ROLES[@]}"; do IDS+=("${r%%"$TAB"*}"); done
  az role assignment delete --ids "${IDS[@]}" --subscription "$SUB"
  echo "deleted ${#IDS[@]} role assignments of $APP_DEPLOY"
fi
if $GROUP_FOUND; then
  echo "deleting the resource group $RG (this takes several minutes)"
  az group delete --name "$RG" --subscription "$SUB" --yes
  echo "deleted the resource group $RG"
fi
for a in ${APPS[@]+"${APPS[@]}"}; do
  IFS="$TAB" read -r appid _ name <<< "$a"
  az ad app delete --id "$appid"
  echo "deleted the app registration $name"
done
if [[ -n "$GROUP" ]]; then
  az ad group delete --group "${GROUP%%"$TAB"*}"
  echo "deleted the group ${GROUP#*"$TAB"}"
fi

if $PURGE; then
  for a in ${ACCOUNTS[@]+"${ACCOUNTS[@]}"} ${SOFT_ACCOUNTS[@]+"${SOFT_ACCOUNTS[@]}"}; do
    IFS="$TAB" read -r name location <<< "$a"
    if az cognitiveservices account purge --name "$name" --resource-group "$RG" --location "$location" --subscription "$SUB"; then
      echo "purged the Foundry account $name"
    else
      echo "warning: the Foundry account $name was not purged; run this again with --purge" >&2
    fi
  done
  for a in ${APPS[@]+"${APPS[@]}"} ${SOFT_APPS[@]+"${SOFT_APPS[@]}"}; do
    if [[ "$a" == *"$TAB"*"$TAB"* ]]; then IFS="$TAB" read -r _ id name <<< "$a"; else IFS="$TAB" read -r id name <<< "$a"; fi
    if az rest --method DELETE --uri "$GRAPH/directory/deletedItems/$id" > /dev/null; then
      echo "purged the app registration $name"
    else
      echo "warning: the app registration $name was not purged (deletion can take a minute to show); run this again with --purge" >&2
    fi
  done
else
  for a in ${ACCOUNTS[@]+"${ACCOUNTS[@]}"}; do
    echo "soft-deleted: the Foundry account ${a%%"$TAB"*}, for 48 hours. Run this again with --purge to free its name."
  done
  for a in ${APPS[@]+"${APPS[@]}"}; do
    echo "soft-deleted: the app registration ${a##*"$TAB"}, restorable for 30 days, and its identifier URI stays taken. Run this again with --purge to free it."
  done
fi

# Vaults have purge protection: nobody can purge them, so they are only reported.
FOUND=$(az keyvault list-deleted --subscription "$SUB" --resource-type vault --query "[].[name,properties.scheduledPurgeDate,properties.vaultId]" -o tsv)
while IFS="$TAB" read -r name date id; do
  if [[ -z "$name" ]] || ! in_our_group "$id"; then continue; fi
  echo "soft-deleted: the vault $name, with its secrets, until $date (purge protection: it can't be purged)."
  KEPT_VAULTS=1
done <<< "$FOUND"
if [[ -n "${KEPT_VAULTS:-}" ]]; then
  echo "To deploy $ENVIRONMENT again before then, deploy pre-deploy.bicep, then run deploy-infra.yml with first-deployment" \
    "and recover-vaults: Bicep recovers the vaults, secrets included, instead of creating them."
fi
echo "clean-up of $ENVIRONMENT done"
