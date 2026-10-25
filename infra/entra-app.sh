#!/usr/bin/env bash
# Entra ID setup for the hosted agent service (SPEC.md L1-6; specs/011 contracts/access-and-sessions.md).
# Creates or updates the API app registration and its Agent.Run app role, requires assignment on the
# service principal, and exposes the delegated scope `user_impersonation` with the Azure CLI
# pre-authorized, so a person assigned Agent.Run can get a token with
# `az account get-access-token --scope <identifier URI>/user_impersonation`. Optionally assigns Agent.Run
# to the deploy service principal (for the post-deployment smoke check) and to people. It never creates
# secrets. It prints AUTH_TENANT_ID and AUTH_AUDIENCE: the audience is the app's client ID, because Entra
# v2.0 access tokens carry it as `aud`, never the identifier URI.
#
# usage: infra/entra-app.sh [--identifier-uri api://x402-l1-agent] [--deploy-sp <deploy app (client) id>]
#                           [--assign-user <user principal name or object id>]...
# needs: az CLI signed in with rights to create app registrations and app-role assignments; jq.
set -euo pipefail

NAME="x402-l1-agent"
IDENTIFIER_URI="api://x402-l1-agent"
DEPLOY_SP=""
USERS=()
# Stable GUIDs so re-runs update the same role and scope instead of adding new ones.
ROLE_ID="5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e51"
SCOPE_ID="5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e52"
# The Azure CLI's well-known public client ID.
AZURE_CLI_APP_ID="04b07795-8ddb-461a-bbee-02f9e1bf7b46"
GRAPH="https://graph.microsoft.com/v1.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --identifier-uri) IDENTIFIER_URI="$2"; shift 2 ;;
    --deploy-sp) DEPLOY_SP="$2"; shift 2 ;;
    --assign-user) USERS+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROLES=$(cat <<JSON
[{"allowedMemberTypes":["User","Application"],"description":"Run the x402 purchasing agent (spends from the shared budget within the mandate)","displayName":"Agent.Run","id":"$ROLE_ID","isEnabled":true,"value":"Agent.Run"}]
JSON
)
ROLES_FILE=$(mktemp)
API_FILE=$(mktemp)
trap 'rm -f "$ROLES_FILE" "$API_FILE"' EXIT
printf '%s' "$ROLES" > "$ROLES_FILE"

APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg --app-roles "@$ROLES_FILE" --query appId -o tsv)
  echo "created app registration $NAME ($APP_ID)" >&2
else
  az ad app update --id "$APP_ID" --app-roles "@$ROLES_FILE"
  echo "updated app registration $NAME ($APP_ID)" >&2
fi
az ad app update --id "$APP_ID" --identifier-uris "$IDENTIFIER_URI"
APP_OBJECT_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)

# Each PATCH sends the whole `api` object as read, changed only where needed: an enabled scope can't be
# removed or edited in place, and a pre-authorization may only name a scope that already exists.
patch_api() {
  az ad app show --id "$APP_ID" --query api -o json \
    | jq --arg scope "$SCOPE_ID" --arg cli "$AZURE_CLI_APP_ID" "$1" > "$API_FILE"
  az rest --method PATCH --uri "$GRAPH/applications/$APP_OBJECT_ID" \
    --headers "Content-Type=application/json" --body "@$API_FILE" > /dev/null
}
# v2.0 access tokens (the service verifies iss = https://login.microsoftonline.com/<tenant>/v2.0), and the
# delegated scope people's tokens are requested for. Admin consent only; the Azure CLI is pre-authorized.
# shellcheck disable=SC2016 # jq variables, not shell ones
patch_api '{api: (.requestedAccessTokenVersion = 2
  | .oauth2PermissionScopes = ((.oauth2PermissionScopes // []) | if any(.id == $scope) then . else . + [{
      id: $scope, value: "user_impersonation", type: "Admin", isEnabled: true,
      adminConsentDisplayName: "Run the x402 agent as the signed-in user",
      adminConsentDescription: "Lets a client run the x402 purchasing agent as the signed-in user. The user still needs the Agent.Run role."
    }] end))}'
# shellcheck disable=SC2016
patch_api '{api: (.preAuthorizedApplications = ([(.preAuthorizedApplications // [])[] | select(.appId != $cli)]
  + [{appId: $cli, delegatedPermissionIds: [$scope]}]))}'

SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)
if [[ -z "$SP_ID" ]]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
fi
# Only principals assigned Agent.Run (users, groups or service principals) can get a token for the API.
az ad sp update --id "$SP_ID" --set appRoleAssignmentRequired=true

# Assigns Agent.Run on the API to one principal (a user or a service principal), once.
assign_role() {
  local principal="$1" label="$2" existing
  existing=$(az rest --method GET --uri "$GRAPH/servicePrincipals/$SP_ID/appRoleAssignedTo" \
    --query "value[?principalId=='$principal' && appRoleId=='$ROLE_ID'] | length(@)" -o tsv)
  if [[ "$existing" == "0" ]]; then
    az rest --method POST --uri "$GRAPH/servicePrincipals/$SP_ID/appRoleAssignedTo" \
      --headers "Content-Type=application/json" \
      --body "{\"principalId\":\"$principal\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"$ROLE_ID\"}" > /dev/null
    echo "assigned Agent.Run to $label (it can now spend through the agent, within the mandate)" >&2
  fi
}

if [[ -n "$DEPLOY_SP" ]]; then
  assign_role "$(az ad sp show --id "$DEPLOY_SP" --query id -o tsv)" "the deploy service principal $DEPLOY_SP"
fi
# ${USERS[@]+…}: an empty array is "unbound" under set -u in bash 3.2 (macOS).
for user in ${USERS[@]+"${USERS[@]}"}; do
  assign_role "$(az ad user show --id "$user" --query id -o tsv)" "the user $user"
done

echo "AUTH_TENANT_ID=$(az account show --query tenantId -o tsv)"
echo "AUTH_AUDIENCE=$APP_ID"
