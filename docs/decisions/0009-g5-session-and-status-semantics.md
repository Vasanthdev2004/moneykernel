# 0009 — G5 session lifetime and truthful console status

Date: 2026-09-08. Review base: `c47a749` (G5 plus the approval drawer style fix).

## Decisions

Logout must end the server session before the console reports that it has
logged out. Bodyless requests omit a JSON content type, avoiding Fastify's
empty-JSON rejection. Failed logout leaves the session visible with a retry
message; an already expired session can return to login. A response lost while
reading its body is a transport failure even if its headers arrived, preserving
the mutation runner's idempotency key for a retry.

The event stream's authorization lasts only as long as the operator session.
The server checks the live session before querying and delivering events and
closes revoked/expired streams. Active streams close in Fastify's `preClose`
hook so they cannot prevent shutdown from reaching `onClose`.

Available quote cash subtracts both active reservations and the current policy
cash buffer, matching PRD section 9.5. The console overview gains the additive
`cash_buffer_quote` decimal-string field, which the matching UI displays
separately. Existing fields and the public schema version remain compatible;
no database migration or policy-engine version change is required.

Command status describes only what that state establishes. `ARMED` does not
prove transmission, and `ACCEPTED` does not establish whether fills exist. The
console displays observed order and reconciliation details separately rather
than asserting that an accepted command is unfilled. Account reconciliation
with zero unknown commands has its own heading; it is not labelled an unknown
order outcome. These changes affect presentation, not command transitions.

## Interface scope

The existing visual direction is preserved. The three-column grid stacks
before its minimum widths overflow the viewport, and receipt rule names and
financial values stay intact within the panel's horizontal scrolling area.
The approval drawer's removed accent border remains removed.
