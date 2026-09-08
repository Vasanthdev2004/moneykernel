# 0010 — G6 export consistency and verification boundaries

Date: 2026-09-08. Reviewed base: `32a2604`.

## Problem

G6's tests passed while altered financial rows could pass the offline verifier with the original audit chain intact. Export reads could combine different committed states, truncate the log at 5,000 events, and include a credential embedded in a valid intent rationale. Several replay checks did not exercise the behavior their labels claimed.

## Decisions

- Read all export families and event pages in one read-only, repeatable-read transaction. New exports declare optional `checkpoint.final_hash` and `final_seq`; historical v1 bundles remain readable.
- Screen the complete bundle using shared credential-key and value-pattern detection, plus configured secret values at export time. Reject unsafe exports with a generic 409. Redacting hash-bound data would destroy verification; no historical artifacts are rewritten. Unknown arbitrary secrets still require human review before publication.
- Bind immutable row identities and financial material to audit events in both directions. Recompute archived decision references and fingerprints with the actual current engine version. Validate exact approval/payload relationships, reservation ownership and amounts, lease usage, signed fill journals, fees, and nonnegative inventory.
- Treat pending, armed, unknown and partially reconciled commands according to their actual lifecycle. The verifier checks known fills without claiming complete settlement until reconciliation is complete.
- Keep `--checkpoint` as the existing predecessor option; add `--head-checkpoint` for an independently retained final event hash. A hash supplied inside the same bundle is a consistency check, not an external trust anchor. Reject empty evidence and disclose unanchored verification. Chain slices cannot prove complete account-row coverage.
- Keep legacy null contexts explicit as fingerprint-only. Version-matched contexts are replayed; unsupported engine versions fail rather than being silently run through a different evaluator.
- Do not echo untrusted schema diagnostics, matched credentials or malformed payload exceptions. Malformed CLI input returns a bounded failure report.
- A run is `SCRIPTED` only if all registered agents are scripted. Mixed or empty runs use `DISABLED` because no verified model-run binding exists in the export.
- Replays reject invalid run counts before configuration and always close resources on failure. Scenario B exercises rejection and selection with separate intent pairs. Scenario C executes its exact retry and later denied submission. Scenario D checks persisted `OUTCOME_UNKNOWN` before boot recovery and `PAUSED` after boot; boot recovery itself reconciles before returning.

## Limits

These changes verify recorded synthetic behavior. Exports contain archived evaluator context and snapshot references/hashes, but not separate raw source snapshot rows. Replay compares context-derived references and results with fingerprinted material; it does not independently reconstruct upstream source payloads. External checkpoint anchoring, receipt-bound live-model provenance, qualified MCP/SHADOW execution, Testnet execution and the G7 recording/submission package retain their existing status. They are not established by offline replay success.
