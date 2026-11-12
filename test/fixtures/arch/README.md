# Architecture rule fixtures (T-ARCH-*, SPEC §4.1)

Each `a<n>-violation.ts` contains exactly one violation of rule A<n>. Its first line declares
the virtual path it is checked under (`// @virtual-path: src/...`). `test/architecture.test.ts`
reads these files as text and passes them to the pure `checkFile(path, source)`; it asserts
that each produces exactly `["A<n>"]` (Principle VIII must-fail proof).

These files are never imported by `src/`, are excluded from `tsc` (tsconfig `exclude`), and
are not test files.

`a8-violation.ts` (009) is checked with `checkCdpConfinement(path, source)` rather than `checkFile`,
because A8's scope also covers `scripts/**` and `env/*.env.example`. The test asserts that `checkFile`
finds nothing in it and A8 finds both the CDP variable and the `@coinbase/cdp-sdk` import.

`a9-violation.ts` (012) is checked with `checkCibaConfinement(path, source)`, for the same reason: A9 confines
L2's Auth0 client credential (`CIBA_CLIENT_KEY`, `CIBA_CLIENT_SECRET`) to `src/layer2-control/ciba-client.ts`
and `env/l2-control.env.example`. The test asserts that `checkFile` and A8 find nothing in it.

`a10-violation.ts`, `a11-violation.ts` and `a12-violation.ts` (013) are checked with `checkCardVaultConfinement`,
`checkMnemonicConfinement` and `checkPortalIsolation`. A10 confines the card vault credential (`CARD_VAULT_KEY`) and
the vault's API host to `src/portal/card-vault.ts` and `env/portal.env.example`. A11 confines the user wallets'
mnemonic (`USER_WALLET_MNEMONIC`) to the signer, the portal's refusal, the local development value and L2's template.
A12 keeps the portal's token out of the agent, the verifier and the counterparty, and every other role's secret out
of `src/portal/`. Each test asserts that no other rule catches its fixture.

`a13-violation.ts` (014) is checked with `checkPortalHalves`. A13 keeps the portal's two halves apart: the
administration role (`portal-admin`) and its token (`PORTAL_ADMIN_TOKEN`) are named only in `src/portal/config.ts`
and `src/portal/admin-client.ts`; only `admin-routes.ts` and `server.ts` import that client; and the administration
half never imports the user-account client. The test asserts that no other rule catches its fixture.
