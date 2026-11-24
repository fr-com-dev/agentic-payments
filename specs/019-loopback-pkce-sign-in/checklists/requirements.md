# Specification Quality Checklist: Loopback PKCE Sign-In from a Desktop Client for the Hosted Agent

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

- Validated on 2026-11-24 in two passes. The first was written as feature 017. It was renumbered 019 because
  two features in progress on other branches use 017 and 018: the DAST findings remediation
  (`claude/spec-17-dast-findings-42d580`) and the tenant sign-up hardening (`claude/pentest-report-fixes-0709b1`).
  The second pass read both and added what they change (Reading spec-19 table, FR-008, FR-009, FR-020..FR-022,
  FR-027, Assumptions).
- No [NEEDS CLARIFICATION] marker was written. Two decisions with no reasonable default were put to the owner and
  are recorded under Clarifications: permission only, with no roles claim (spec-19 row 2); and a 401 that tells
  missing, expired and invalid apart and nothing else (spec-19 row 5 against the DAST remediation's FR-024).
- "No implementation details": the spec names only values the owner's spec-19 names itself (the loopback
  addresses and port, the scopes, the error codes, `azp` and `client_id`, `AUTH_AUDIENCE`, `AUTH_ISSUER`) and the
  vocabulary the normative `SPEC.md` already uses (the tenant, people's API, `agent:run`, `x402-agent`, L1/L2).
  It names no file, module, library or framework. The plan decides how the account question crosses L2's API,
  where the desktop client's identifier is configured, and how the post-login rule learns that identifier.
- Two of spec-19's values are corrected to the repository's, as the mapping table and Assumptions say: the
  audience is people's API (`AUTH_AUDIENCE`), not `agentic-payments-claude-client`, and the role is the existing
  `x402-agent`, not a new `agent-runner`. Both follow from spec-19's own token checks and from the tenant's
  two-role rule (T-IAC-02, the constitution's Technology & Scope).
- Defaults chosen where spec-19 left a choice: 409 for an account that is not ready (spec-19 allows 403 or 409;
  409 keeps it apart from the role refusal), 503 when L2 cannot answer, and the desktop client on the same
  connections as the agent's docs page client.
- spec-19 rows already in place are kept as checks, not rework: people's API settings (FR-004), the client from
  `azp` and `client_id` (FR-012), limits per person (FR-014), and the run log's identifiers (FR-023 adds the
  client only). The bearer challenge on the agent's 401 comes from the DAST remediation (FR-020).
- This feature changes recorded decisions: the tenant's fixed applications go from three to four (the
  constitution's Technology & Scope, T-IAC-02); the docs page's client stays without refresh tokens while the
  desktop client gets them (`specs/016` Assumptions); a person's run without an account is refused before it
  starts instead of being denied per purchase (`specs/016` Edge Cases); the tenant sign-up hardening's rule that
  only the portal's and the agent's applications sign people in gains the desktop client (FR-009); and the DAST
  remediation's 401 rule gains one exception, the expiry (FR-022). FR-027 requires the amendments to `SPEC.md`
  and the constitution before any code, after those two features' own.
