# 0004 — Durable operator requests and scoped mutations

Date: 2026-09-08

Migration `0004_operator_requests.sql` stores operator request identities,
canonical payload hashes, and recorded HTTP results. Apply it with
`pnpm db:migrate` before starting this kernel; boot does not migrate automatically.

Approval, conflict resolution, stop, and resume requests commit a `PENDING`
claim under the account lock before invoking their existing control transaction.
The identity includes account, operator, operation scope, and idempotency key;
the hash also binds the method, route parameters, and request body. A different
payload with the same identity returns `409 IDEMPOTENCY_KEY_REUSED`.

A completed action records its HTTP status and body before replying. Exact
retries replay this result across sessions and restarts without executing the
action again. Replay is historical: an old resume result does not mean that a
later stop or restart has left the account ready. Clients should inspect current
status when the `Idempotent-Replayed` header is present.

The claim, existing action, and result use separate transactions. A crash or
unexpected failure between them can leave `PENDING` even if the action committed.
Concurrent duplicates and later retries of such a claim return `409 STATE_CONFLICT`
and never rerun it automatically. There is no endpoint that clears the claim.
An operator must inspect account state and audit evidence before explicitly
choosing any new action. A new key must not be used as an automatic retry workaround.
Known service errors are recorded as completed results; uncertain errors retain
the pending claim. Process memory is not an authority source for these requests.

Policy precondition checking, version creation, and invalidation of old pending
authority now share one account-locked transaction. Lease and inventory writes
check that referenced agents belong to this account. Inventory assignments
preserve total owned quantities and existing base reservations, and are blocked
while execution commands remain outstanding.

With `ENABLE_PUBLIC_MUTATIONS=false`, authenticated remote clients may read,
establish sessions, and log out, but cannot perform product mutations. The check
uses the actual peer address with proxy trust disabled; forwarding headers cannot
turn a remote request into loopback. Local tools retain access. Enabling public
mutations does not relax authentication or browser CSRF checks.
