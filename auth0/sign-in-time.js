// The first post-login Action of auth0/main.tf (auth0_action.sign_in_time; SPEC L2-8, specs/013 research R19). Auth0
// runs it after each sign-in, and again when a session or a refresh token renews a token.
// It writes one claim on the access token: the time of the person's most recent authentication, in seconds since the
// epoch, like OIDC's auth_time. Auth0 puts auth_time in the ID token only, and the portal reads the access token.
// L2 judges from this time whether a change that loosens a policy follows a fresh sign-in.
// Phase 3: every interactive sign-in of an administrator (the role x402-admin, auth0_role.admin) ends with a second
// factor. On a sign-in in a browser (the OIDC protocols) whose most recent second factor (a method named mfa) is
// older than its other methods, or that has none, it asks Auth0 to challenge the person with Guardian push or a
// one-time code. Never on a refresh-token exchange or any other protocol, where Auth0 can't show a challenge, and
// never for anyone else but a person signing in through the desktop client (019, below). Auth0 challenges once this Action has run, so the time of that second factor is written by
// the next one, mfa-time.js. An administrator enrolled in neither factor can't complete the challenge, and Auth0
// then ends the sign-in: enroll them before giving them the role.
// 019 (specs/019 FR-006..FR-008): it fails a sign-in only for the desktop client (auth0_client.desktop, recognized by
// the public marker its client_metadata carries, x402_client = "agent-desktop"), and only for two reasons. First, a
// person without the role x402-agent gets no desktop sign-in and no renewal of one (not_authorized_for_agent), so a
// removed role stops the renewals. Second, a desktop sign-in whose /authorize request did not use PKCE with S256 is
// refused (pkce_required): the tenant itself doesn't require PKCE, and accepts the plain method. Both run before any
// challenge, so nobody is asked for a second factor first, and because Auth0 may give a later Action a new request
// after a challenge. Then the desktop client's interactive sign-ins get the administrators' second factor.
// It sets nothing else. Without a time it sets no claim: the current time would make a renewed token look like a new
// sign-in. T-IAC-02 (test/auth0-iac.test.ts) runs this file.
const CLAIM = "https://x402.dev/auth_time";
const ADMIN_ROLE = "x402-admin";
const AGENT_ROLE = "x402-agent";
const DESKTOP_CLIENT = "agent-desktop";
const RENEWAL = "oauth2-refresh-token";
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

  // 019: the desktop client only. The refusals come before any challenge.
  const metadata = (event.client && event.client.metadata) || {};
  const desktop = metadata.x402_client === DESKTOP_CLIENT;
  if (desktop) {
    if (!(Array.isArray(roles) && roles.includes(AGENT_ROLE))) {
      api.access.deny("not_authorized_for_agent");
      return;
    }
    const renewal = (event.transaction && event.transaction.protocol) === RENEWAL;
    const query = (event.request && event.request.query) || {};
    if (!renewal && (!query.code_challenge || query.code_challenge_method !== "S256")) {
      api.access.deny("pkce_required");
      return;
    }
  }
  if ((admin || desktop) && browser && !freshSecondFactor) {
    api.authentication.challengeWithAny(SECOND_FACTORS);
  }
};
