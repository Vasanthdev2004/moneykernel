# G5 independent review and corrections

Reviewed `c47a749` on 2026-09-08 in an isolated checkout while G6 development
continued. This includes G5 `57cf4fa`, its drawer style adjustment, and the merged
G4 fixes. Checks use disposable PostgreSQL 17 and virtual REPLAY funds; the
development checkout and its database are untouched.

## Reproduced failures

- Browser logout returned to the login screen but left its server session
  valid: the DELETE request declared JSON without a body and was refused
  before session deletion. The regression expected subsequent session lookup
  to return 401 and observed 200. Logout now sends a valid bodyless request;
  network failure stays visible and requires a retry.
- A response body lost after headers escaped as a plain exception, causing
  the mutation runner to discard its retry key. The client now treats that
  failure as an unknown transport result and preserves retry eligibility.
- An already open SSE connection continued delivering after logout or session
  expiry. Live authorization now gates delivery. A separate reproduction
  showed active SSE preventing graceful server shutdown; streams now close
  before the server waits for connections to end.
- Scenario A displayed 110 USDT available despite its 10 USDT cash buffer.
  The overview now reports 100 available and displays the buffer separately.
  Changing the policy updates that breakdown on subsequent reads.
- A fully filled/reconciled command was labelled `ACCEPTED · NOT FILLED`, and
  `ARMED` claimed an order had been sent even before transport. Labels now
  distinguish command state from observed order/fill evidence. A known
  accounting discrepancy uses `ACCOUNT RECONCILING` rather than an inaccurate
  `OUTCOME UNKNOWN` heading.
- A 1024px viewport overflowed to 1118px, and a receipt rule identifier wrapped
  over four lines. The grid now stacks before its minimum widths overflow;
  exact rule names and amounts remain intact in the scrollable receipt panel.

The [session and status decision](decisions/0009-g5-session-and-status-semantics.md)
records the additive overview field and compatibility choices.

## Verification

The unmodified baseline passed 406 tests, skipped 3 opt-in online tests, and
passed both existing Chromium browser tests. Lint, typecheck, and the production
build passed. The failures above were reproduced separately before correction.

Final combined validation:

- `pnpm test`: **415 passed, 3 opt-in online tests skipped**, across 40 passing
  files and 1 skipped file. This includes 9 new non-browser regressions.
- `pnpm test:e2e`: **7 passed** in Chromium, including 5 new browser flows.
- `pnpm lint`, `pnpm build` (including both TypeScript configurations), and
  `git diff --check`: passed.
- `pnpm run doctor`: all required checks passed; four migrations applied and
  223 staged/tracked files scanned without a secret-like value.

The browser suite ran after the integration suite, against the same disposable
database with a fresh REPLAY account alias. No new live market/provider calls
were needed for these console changes. The original G5 screenshot is preserved;
the browser assertions verify the corrected rendered values and state labels.

Browser checks exercise the real kernel and Vite console, including:

- Keyboard confirmation and exact approval through settlement, receipt export,
  and event catch-up after reload without duplicates.
- Phone/tablet mode and stop visibility, keyboard modal opening/closing and
  restored focus, plus the cash-buffer breakdown and readable receipt rules.
- Successful logout surviving reload, and interrupted logout remaining visible
  until the operator retries.
- Opposing BUY and owned-inventory SELL held together; selecting one requires
  a fresh unchecked approval, while rejecting both releases their holds.
- Operator quarantine releasing pending holds while preserving owned inventory,
  followed by a fresh agent request denied as `AGENT_QUARANTINED`.

## Remaining scope

G6 owns export/replay verification, fault coverage, and receipt-to-model-run
provenance. The integration qualification limits in the G4 review remain:
unverified Binance MCP access, unsupported applicable SHADOW filters, and the
missing T-26 deferred-intent behavior. G7 still owns release rehearsals and the
submission package. G5 browser evidence does not qualify those remaining gates.
