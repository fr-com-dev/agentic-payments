# Specification Quality Checklist: L2 Web Portal: Onboarding, Profile, Wallet and Expense Policies

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-10
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

- **Three clarifications resolved (2026-11-10)**, asked before the spec was written and recorded
  in its Clarifications section:
  - cards are registered only, never charged;
  - many users onboard by self-service, which makes L2 multi-user;
  - approvals above the auto-approve limit stay with the existing paths (004, 010, 012).
- **Defaults chosen without asking**, each recorded under Assumptions and open to
  `/speckit-clarify`:
  - the crypto account is created by the system and its key held by L2's signer;
  - a user may have several policies, split by seller, with one active policy per seller;
  - policy fields are today's mandate fields, bounded by operator-set platform limits;
  - no withdrawals, and test funds and test cards only;
  - the constants: 10 active policies, 20 sellers per policy, 5 cards, 30-second balances, 15
    minutes for identity confirmation.
- **Validation, iteration 1** found four issues, all fixed in iteration 2:
  - "onboarding complete" required an active policy, so pausing every policy would have undone
    onboarding. It now means a first policy was saved (FR-011, FR-012);
  - "spent today" did not match the daily budget, which counts the last 24 hours (FR-015);
  - NFR-001's second sentence was not testable and was replaced;
  - the low-wallet edge case now says the amount stays committed until the authorization lapses.
- **Project terms are not implementation detail.** Ledger entries, rule IDs such as
  `host_not_allowed`, requirement IDs and `npm run demo:local` (SC-012, the constitution's
  regression gate) follow the convention of specs 008, 010 and 012. The spec names no framework,
  storage, identity provider or card vendor; the Assumptions leave those to the plan.
- **This feature amends scope the constitution lists as out.** Multi-tenancy is out of scope in
  constitution v1.3.0 and SPEC §1.3. The spec lists the constitution amendment (MINOR) and the
  SPEC.md sections to change; the plan's Constitution Check must cover them.
- **Two storage questions are left to the plan on purpose:** where profiles are kept (they must
  stay out of the ledger, FR-040) and how per-user account keys are kept inside the signer's
  boundary (FR-014).
- **Validation:** iteration 2. Every item passes. Ready for `/speckit-clarify` or `/speckit-plan`.
