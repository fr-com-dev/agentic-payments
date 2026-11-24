#!/usr/bin/env bash
# The Auth0 tenant's operator command (SPEC 1.26; auth0/README.md "Run it"). It plans and applies auth0/ on the
# operator's host, with Terraform's state in a local file outside every checkout. Nothing else changes the tenant:
# no GitHub workflow holds an Auth0 credential, and .github/workflows/validate-auth0.yml only runs `validate`.
#
#   npm run auth0:tenant -- validate            offline: the pinned Terraform, the locked provider, fmt and validate
#   npm run auth0:tenant -- plan                validate, then a plan of the tenant, saved beside the state
#   npm run auth0:tenant -- apply               exactly the saved plan, then the outputs; the plan is deleted
#   npm run auth0:tenant -- output              the outputs (none is a secret)
#   npm run auth0:tenant -- terraform <args>    another Terraform command on the same state (import, state list,
#                                               state rm, show); never apply or destroy, which go through plan
#
# Its files, each the operator's own and readable by nobody else (it refuses one that is not):
#   $X402_TFSTATE_DIR (default ~/x402-tfstate, mode 0700)
#     auth0.<environment>.tfstate   the state: no secret (T-IAC-02), but what Terraform plans against. Back it up.
#     auth0.<environment>.tfvars    Terraform's variables (auth0/README.md); never environment, credential or
#                                   client_secret, which this script sets or never sets
#     auth0.<environment>.tfplan    the plan the last `plan` saved, until `apply` applies it
#   $AUTH0_CREDENTIAL_FILE (default ~/x402-secrets/auth0-management.<environment>.env, mode 0600)
#     AUTH0_CLIENT_ID=<the Management API application's client ID>
#     AUTH0_CLIENT_SECRET=<its secret>
# The credential reaches Terraform's environment only, never this shell's exports, a file of the checkout or a log.
# AUTH0_ENVIRONMENT picks the environment (default dev). Terraform is the pinned release, checked against its
# SHA-256 and installed in ~/.local/bin without sudo; a terraform elsewhere on PATH is never used.
set -euo pipefail
umask 077

TERRAFORM_VERSION=1.15.5
# terraform_1.15.5_linux_amd64.zip, from https://releases.hashicorp.com/terraform/1.15.5/terraform_1.15.5_SHA256SUMS.
TERRAFORM_SHA256=702b2136af6728c8ff037f843dd2dbce2b7ad88786b7381d1d72aefa250f601c

fail() {
  echo "auth0-tenant: $*" >&2
  exit 1
}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR="$ROOT/auth0"
ENVIRONMENT=${AUTH0_ENVIRONMENT:-dev}
[[ "$ENVIRONMENT" =~ ^[a-z0-9]{2,10}$ ]] || fail "AUTH0_ENVIRONMENT $ENVIRONMENT is not an environment name (2-10 lowercase letters or digits)"
STATE_DIR=${X402_TFSTATE_DIR:-$HOME/x402-tfstate}
STATE="$STATE_DIR/auth0.$ENVIRONMENT.tfstate"
TFVARS="$STATE_DIR/auth0.$ENVIRONMENT.tfvars"
PLAN="$STATE_DIR/auth0.$ENVIRONMENT.tfplan"
CREDENTIAL_FILE=${AUTH0_CREDENTIAL_FILE:-$HOME/x402-secrets/auth0-management.$ENVIRONMENT.env}
TF="$HOME/.local/bin/terraform"

# The pinned Terraform, downloaded only when ~/.local/bin holds another version or none.
install_terraform() {
  if [[ -x "$TF" ]] && [[ "$("$TF" version -json 2>/dev/null)" == *"\"terraform_version\": \"$TERRAFORM_VERSION\""* ]]; then return; fi
  [[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || fail "the pinned Terraform's checksum is for linux_amd64; this host is $(uname -s)/$(uname -m)"
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/terraform.zip" "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"
  if ! echo "$TERRAFORM_SHA256  $tmp/terraform.zip" | sha256sum -c --quiet -; then
    rm -rf "$tmp"
    fail "the Terraform download does not match its SHA-256; nothing was installed"
  fi
  if command -v unzip > /dev/null; then
    unzip -q -o "$tmp/terraform.zip" terraform -d "$tmp"
  else
    python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("terraform", sys.argv[2])' "$tmp/terraform.zip" "$tmp"
  fi
  mkdir -p "$(dirname "$TF")"
  install -m 0755 "$tmp/terraform" "$TF"
  rm -rf "$tmp"
  echo "auth0-tenant: installed Terraform $TERRAFORM_VERSION in $TF"
}

# The file exists, is not a link, is the operator's own, and nobody else may read or write it.
private() {
  local path=$1 mode=$2
  [[ -e "$path" && ! -L "$path" ]] || fail "$path is missing (or a link): auth0/README.md, \"Run it\""
  [[ "$(stat -c '%u %a' "$path")" == "$(id -u) $mode" ]] || fail "$path must be yours, with mode $mode (chmod $mode $path)"
}

# The Management API credential, from its own file: two lines and nothing else, never sourced as a script.
CLIENT_ID=""
CLIENT_SECRET=""
read_credential() {
  private "$(dirname "$CREDENTIAL_FILE")" 700
  private "$CREDENTIAL_FILE" 600
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      AUTH0_CLIENT_ID=*) CLIENT_ID=${line#AUTH0_CLIENT_ID=} ;;
      AUTH0_CLIENT_SECRET=*) CLIENT_SECRET=${line#AUTH0_CLIENT_SECRET=} ;;
      "" | "#"*) ;;
      *) fail "$CREDENTIAL_FILE may hold only AUTH0_CLIENT_ID= and AUTH0_CLIENT_SECRET= lines" ;;
    esac
  done < "$CREDENTIAL_FILE"
  [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || fail "$CREDENTIAL_FILE needs AUTH0_CLIENT_ID= and AUTH0_CLIENT_SECRET="
}

# The variables file: L2's credential is held by L2 only (Constitution V), so this script provisions
# credential = "key" and never takes a client secret; no private key either. No secret of any kind goes in this file
# (specs/017 research R9): the Google application's is entered in the tenant's Dashboard only.
check_tfvars() {
  private "$STATE_DIR" 700
  private "$TFVARS" 600
  if grep -Eq '^[[:space:]]*(environment|credential|[[:alnum:]_]*secret[[:alnum:]_]*)[[:space:]]*=' "$TFVARS"; then
    fail "$TFVARS must not set environment, credential or any variable whose name holds secret: this script sets the first two, always credential = \"key\", and no secret goes in this file"
  fi
  if grep -q 'PRIVATE KEY' "$TFVARS"; then fail "$TFVARS holds a private key: only public halves go there"; fi
  if grep -q 'GOCSPX-' "$TFVARS"; then fail "$TFVARS holds a Google client secret: it goes into the tenant's Dashboard only"; fi
  [[ ! -e "$STATE" ]] || private "$STATE" 600
}

# Terraform in auth0/, with the credential in its environment only.
tf() {
  AUTH0_CLIENT_ID="$CLIENT_ID" AUTH0_CLIENT_SECRET="$CLIENT_SECRET" TF_INPUT=0 \
    TF_VAR_environment="$ENVIRONMENT" TF_VAR_credential=key "$TF" -chdir="$DIR" "$@"
}

# The provider exactly as .terraform.lock.hcl pins it, then the offline checks.
validate() {
  tf init -backend=false -lockfile=readonly -no-color > /dev/null
  tf fmt -check -diff
  tf validate -no-color
}

# The state at its path outside the checkout: -reconfigure, since every checkout and worktree has its own .terraform/.
init_state() {
  tf init -reconfigure -lockfile=readonly -no-color -backend-config="path=$STATE" > /dev/null
}

outputs() {
  local name
  for name in l2_env portal_env l1_env; do
    echo "### $name"
    tf output -no-color -raw "$name"
    echo
  done
  for name in bicepparam_ciba bicepparam_identity bicepparam_portal_client_id bicepparam_agent; do
    echo "### $name"
    tf output -no-color -json "$name"
  done
}

command=${1:-}
if [[ $# -gt 0 ]]; then shift; fi
case "$command" in
  validate)
    install_terraform
    validate
    ;;
  plan)
    install_terraform
    check_tfvars
    read_credential
    validate
    init_state
    tf plan -no-color -lock-timeout=120s -var-file="$TFVARS" -out="$PLAN"
    echo "auth0-tenant: the plan is saved as $PLAN. Apply exactly it with: npm run auth0:tenant -- apply"
    ;;
  apply)
    install_terraform
    check_tfvars
    read_credential
    private "$PLAN" 600
    init_state
    tf apply -no-color -lock-timeout=120s "$PLAN"
    rm -f "$PLAN"
    outputs
    ;;
  output)
    install_terraform
    check_tfvars
    init_state
    outputs
    ;;
  terraform)
    [[ $# -gt 0 ]] || fail "terraform needs a command (import, state list, show, ...)"
    case "$1" in
      apply | destroy) fail "terraform $1 is not run here: plan, then apply exactly the saved plan" ;;
    esac
    install_terraform
    check_tfvars
    read_credential
    init_state
    sub=$1
    shift
    case "$sub" in
      import | console | refresh) tf "$sub" -var-file="$TFVARS" "$@" ;;
      *) tf "$sub" "$@" ;;
    esac
    ;;
  *)
    fail "usage: npm run auth0:tenant -- validate | plan | apply | output | terraform <args> (auth0/README.md)"
    ;;
esac
