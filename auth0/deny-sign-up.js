// The pre-user-registration Action of auth0/main.tf (auth0_action.deny_sign_up; Phase 3), bound only while
// var.allow_sign_ups is false. It refuses every new account in the tenant's database and passwordless connections,
// whoever asks: the sign-up page, the public sign-up endpoint, the Dashboard and the Management API. A first sign-in
// through a social or enterprise connection doesn't run this trigger. It reads nothing of the event and holds no
// secret. T-IAC-02 (test/auth0-iac.test.ts) runs this file.
exports.onExecutePreUserRegistration = async (event, api) => {
  api.access.deny("sign_up_closed", "Sign-ups are closed");
};
