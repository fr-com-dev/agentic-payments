// The first post-login Action of auth0/main.tf (auth0_action.sign_in_time; SPEC L2-8, specs/013 research R19). Auth0
// runs it after each sign-in, and again when a session or a refresh token renews a token.
// It writes one claim on the access token: the time of the person's most recent authentication, in seconds since the
// epoch, like OIDC's auth_time. Auth0 puts auth_time in the ID token only, and the portal reads the access token.
// L2 judges from this time whether a change that loosens a policy follows a fresh sign-in.
// Phase 3: every interactive sign-in of an administrator (the role x402-admin, auth0_role.admin) ends with a second
// factor. On a sign-in in a browser (the OIDC protocols) whose most recent second factor (a method named mfa) is
// older than its other methods, or that has none, it asks Auth0 to challenge the person with Guardian push or a
// one-time code. Never on a refresh-token exchange or any other protocol, where Auth0 can't show a challenge, and
// never for anyone else. Auth0 challenges once this Action has run, so the time of that second factor is written by
// the next one, mfa-time.js. An administrator enrolled in neither factor can't complete the challenge, and Auth0
// then ends the sign-in: enroll them before giving them the role.
// It sets nothing else and never fails a sign-in by itself. Without a time it sets no claim: the current time would
// make a renewed token look like a new sign-in. T-IAC-02 (test/auth0-iac.test.ts) runs this file.
const CLAIM = "https://x402.dev/auth_time";
const ADMIN_ROLE = "x402-admin";
const BROWSER_PROTOCOLS = ["oidc-basic-profile", "oidc-hybrid-profile", "oidc-implicit-profile"];
const SECOND_FACTORS = [{ type: "push-notification" }, { type: "otp" }];

exports.onExecutePostLogin = async (event, api) => {
  // Each method the person completed in this session (a password, a second factor), with the time it was completed.
  const methods = (event.authentication && event.authentication.methods) || [];
  let latest = 0;
  let latestMfa = 0;
  let latestOther = 0;
  for (const method of methods) {
    const at = Date.parse(method && method.timestamp);
    if (Number.isFinite(at) && at > latest) latest = at;
    if (!Number.isFinite(at)) continue;
    if (method.name === "mfa") latestMfa = Math.max(latestMfa, at);
    else latestOther = Math.max(latestOther, at);
  }
  if (latest > 0) {
    api.accessToken.setCustomClaim(CLAIM, Math.floor(latest / 1000));
  }

  const roles = (event.authorization && event.authorization.roles) || [];
  const admin = Array.isArray(roles) && roles.includes(ADMIN_ROLE);
  const browser = BROWSER_PROTOCOLS.includes(event.transaction && event.transaction.protocol);
  const freshSecondFactor = latestMfa > 0 && latestMfa >= latestOther;
  if (admin && browser && !freshSecondFactor) {
    api.authentication.challengeWithAny(SECOND_FACTORS);
  }
};
