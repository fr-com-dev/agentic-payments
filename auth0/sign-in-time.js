// The post-login Action of auth0/main.tf (auth0_action.sign_in_time; SPEC L2-8, specs/013 research R19). Auth0 runs it
// after each sign-in, and again when a session or a refresh token renews a token.
// It writes one claim on the access token: the time of the person's most recent authentication, in seconds since the
// epoch, like OIDC's auth_time. Auth0 puts auth_time in the ID token only, and the portal reads the access token.
// L2 judges from this time whether a change that loosens a policy follows a fresh sign-in.
// It sets nothing else and never fails a sign-in. Without a time it sets no claim: the current time would make a
// renewed token look like a new sign-in. T-IAC-02 (test/auth0-iac.test.ts) runs this file.
const CLAIM = "https://x402.dev/auth_time";

exports.onExecutePostLogin = async (event, api) => {
  // Each method the person completed in this session (a password, a second factor), with the time it was completed.
  const methods = (event.authentication && event.authentication.methods) || [];
  let latest = 0;
  for (const method of methods) {
    const at = Date.parse(method && method.timestamp);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest > 0) {
    api.accessToken.setCustomClaim(CLAIM, Math.floor(latest / 1000));
  }
};
