# Specification Quality Checklist: Remediation of the Portal's DAST Findings

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-23
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

- Iteration 1 (2026-11-23) failed three items, fixed in the spec:
  - "No [NEEDS CLARIFICATION] markers remain": one marker, on whether the dev host stays public (User Story 4,
    FR-021). Resolved in the Clarifications session: only an allow-list or a private network gets through the
    proxy.
  - "Requirements are testable and unambiguous": FR-012 said a browser navigation "MAY" get the page while User
    Story 5 required it; now a MUST, keyed on a request that accepts HTML. FR-015 ended with "the other powerful
    features"; now an explicit minimum list.
  - "Success criteria are technology-agnostic": SC-009 named a project command; now "the definition-of-done check".
- Iteration 2: all items pass.
- Judgment calls kept on purpose:
  - Header names, status codes (401, 404, 421, 429) and HSTS values appear in requirements and success criteria.
    They are the observable behavior the DAST measured and a re-test checks, not a choice of implementation; the
    spec names no language, framework, library or file layout for them.
  - Caddy and Auth0 are named only as the environment that exists today (the dev host's proxy, the sign-in
    tenant), as earlier specs in this repository do. The requirements say "the front proxy" and "the tenant".
  - The audience is the system's owner and operator, who read security findings; the spec avoids code terms but
    keeps the protocol terms that the findings themselves use.
  - The hosted agent is in scope for FR-004..FR-010 and FR-024 only (see Assumptions); this widens the scan's
    target on purpose, because the agent shares those checks with the portal.
  - The dev host's name is left out of the repository; the report stays outside it.
- Plan (2026-11-23) amended FR-028: must-fail switches for the guards, the limit and the 404 rules; headers, the
  challenge and the deployment build proven by assertions on every kind of answer and by a control build.
- Amended after `/speckit-analyze` (2026-11-24): FR-020 now covers every build a deployment serves, so the
  pipelines' never-served check build may keep the dev sign-in (research R11); SC-005 now names the fixed probe
  list that covers the report's examples and families, since the report does not list its 56 paths and 8 payloads.
  Also: FR-010 and US3 scenario 4 say "per service instance" (one per process in a deployment), and FR-021
  points to FR-003 instead of restating part of it.
