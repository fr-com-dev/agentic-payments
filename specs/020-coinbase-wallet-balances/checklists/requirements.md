# Specification Quality Checklist: Connected Platforms in the L2 Portal: Coinbase Balances

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-25
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Validated on 2026-11-25 in two passes. The first left three [NEEDS CLARIFICATION] markers, put to the owner:
  which Coinbase (FR-004), how long a connection lasts (FR-011) and which balance figures are shown (FR-013).
  The owner chose the Coinbase account (not a self-custody address), a connection that lasts until
  disconnected, and each asset's units plus Coinbase's value and a Coinbase total. The answers are recorded
  under Clarifications, and the second pass found every item passing.
- "No implementation details": the spec names no file, module, library, protocol or Coinbase API. It uses the
  vocabulary the normative `SPEC.md` already uses (the control layer, the ledger, the portal, the two agent tools,
  requirement IDs). The plan decides how the grant is protected, how Coinbase is read and how connection events
  reach the audit trail.
- Interpretation recorded under "Reading the request against the repository": the portal already shows the L2
  account's balance (013 FR-015), so this feature adds connected platforms beside it, view only.
- Planning, 2026-11-25, changed the spec in four places, each recorded in the spec and in research.md: values are in
  US dollars at Coinbase's own rates, rounded to the cent (R7; the clarification's "user's currency" refined);
  FR-015 and SC-002 follow; FR-030 is new (Coinbase's terms require a privacy policy and a support contact, R8); and
  the Assumptions record that Coinbase isn't issuing OAuth clients now and has no sandbox (R0, R13). Every item
  still passes.
- Analysis, 2026-11-25 (`/speckit-analyze`), fixed the critical, high and medium findings. In the spec: US1 and
  FR-007 name the renewable grant (`offline_access`) beside read access; US5 scenario 3 no longer says the portal
  refuses to start with user accounts off (a deployment's parameters refuse it, and a portal in front of a control
  layer without user accounts offers nothing); FR-025 says what is enforced (no other app of a deployment, and the
  agent refuses it). Elsewhere: three more must-fail switches (`skipPkce`, `unserializedRenewals`,
  `trustRevokeAnswer`), the entry types renamed `CONNECTION_OPENED` and `CONNECTION_CLOSED`, the wallet's reconcile
  never waiting for Coinbase, a check that the portal makes only the six calls of contracts/coinbase.md, and [P] only
  on tasks that touch a file of their own. Seven low findings are left as they are. Every item still passes.

