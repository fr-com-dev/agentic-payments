# Specification Quality Checklist: Sign-Up Hardening for the Sign-In Tenant (pentest finding P1)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-24
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

- Validation pass 1 (2026-11-24): every item passes.
- The spec uses this project's own vocabulary on purpose: role and permission names (`x402-agent`,
  `agent:run`, `portal:admin`), SPEC IDs (SEC-26, SEC-19, R21), "the tenant", "the offline check" and "the plan".
  It does the same as specs/016. It names no Terraform resource, Action, file or library. How each requirement is
  met (connection resources, the pre-registration rule, where the Google secret is set) is left to
  `/speckit-plan`.
- Three decisions were taken with the owner on 2026-11-24 and are recorded under Clarifications. Google sign-up is
  public by design. Email-and-password sign-up stays closed. R21 stands: no role is needed to use the portal, and
  the agent role is needed to run the agent.
- Two facts for planning to confirm, both listed in Assumptions. First, Google's account identifier must not change
  with the Google application (FR-009); if it does, the switch stops. Second, it must settle whether L2's approval
  client needs a person's connection for the backchannel request (FR-017).
- Validation pass 2 (2026-11-24, after `/speckit-plan`). Planning settled both facts and made three requirements
  precise:
  - Google publishes the "public" subject type, the same `sub` for every client, so existing Google people keep
    their account. One person checks it by hand first (research R8).
  - Auth0's CIBA pages require no connection for the CIBA client, and the backchannel live check confirms it where
    CIBA is on (research R3).
  - FR-003, FR-007 and FR-018, US3 and SC-005 were reworded. The refusal is the provider's own sign-up-disabled
    answer, the evidence of the Google app is the redirect to Google, and a Google connection changed by hand fails
    the plan. Every item still passes.
