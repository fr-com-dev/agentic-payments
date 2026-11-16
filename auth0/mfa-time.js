// The second post-login Action of auth0/main.tf (auth0_action.mfa_time; Phase 3), bound after sign-in-time.js. Auth0
// runs it after each sign-in and renewal, and after any second factor sign-in-time.js asked for, so that factor is
// among the methods it sees.
// It writes one claim on the access token: the time of the person's most recent second factor (a method named mfa),
// in seconds since the epoch. The services require it, fresh, for an administrator's decision on a payment.
// It sets nothing else and never fails a sign-in. Without a second factor it sets no claim, and it never writes the
// current time, which would make a renewed token look like a new second factor. T-IAC-02 (test/auth0-iac.test.ts)
// runs this file.
const CLAIM = "https://x402.dev/mfa_time";

exports.onExecutePostLogin = async (event, api) => {
  const methods = (event.authentication && event.authentication.methods) || [];
  let latest = 0;
  for (const method of methods) {
    const at = Date.parse(method && method.timestamp);
    if (method && method.name === "mfa" && Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest > 0) {
    api.accessToken.setCustomClaim(CLAIM, Math.floor(latest / 1000));
  }
};
