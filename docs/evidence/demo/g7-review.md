# Independently verified G7 rehearsal evidence

Code revision: `56a44fb5b07b9d9ef5dd1c41122753bc061cd0d8`, based on merged G6 review `f1b0062`.

`pnpm demo:rehearse` passed all twelve scenes in three consecutive rounds (55.8 seconds). Each scene used a fresh REPLAY account, downloaded that account's complete export through the console, and verified it offline. All twelve exports and reports are published; round 1 also includes all nine screenshots. The other rounds' screenshots remain local to avoid duplicating the visual package.

The [manifest](g7-review-manifest.json) maps every scene to its account, export, verification report, event head and published screenshots. It records SHA-256 hashes of the artifacts. Event heads were copied from those exports; they are not independent trust anchors. The [review report](../../g7-fix-test-evidence.md) explains the corrections and validation limits.

| Scene | Round 1 evidence | What the rehearsal asserted |
|---|---|---|
| A | [Export](g7-verified-20260908T102850Z-run1/a.export.json), [verification](g7-verified-20260908T102850Z-run1/a.verification.json), [settled console](g7-verified-20260908T102850Z-run1/a3-settled-fill-and-receipt.png) | Counterproposal of 0.27 SOL, exact operator approval, reconciled fill and verifiable receipt |
| B | [Export](g7-verified-20260908T102850Z-run1/b.export.json), [verification](g7-verified-20260908T102850Z-run1/b.verification.json), [selected winner](g7-verified-20260908T102850Z-run1/b2-winner-revalidated-loser-released.png) | Opposing intents held; selection revalidates the winner, releases the loser and creates no approval or command |
| C | [Export](g7-verified-20260908T102850Z-run1/c.export.json), [verification](g7-verified-20260908T102850Z-run1/c.verification.json), [quarantine](g7-verified-20260908T102850Z-run1/c1-burst-quarantined.png) | Burst quarantine, zero reserved funds and no execution authority |
| D | [Export](g7-verified-20260908T102850Z-run1/d.export.json), [verification](g7-verified-20260908T102850Z-run1/d.verification.json), [unknown state](g7-verified-20260908T102850Z-run1/d1-outcome-unknown-banner.png), [recovered state](g7-verified-20260908T102850Z-run1/d2-recovered-after-restart.png) | Same command and client order ID across restart, one venue submission, 0.12 SOL / 12 USDT fill, 0.012 USDT fee, 12.012 consumed and 8.008 released |

Scene D deliberately combines a lost submission response with a synthetic, process-local query outage until restart. This keeps the unknown-state recording reproducible. Ordinary dropped-response recovery remains automatic when the additional fault is absent. The [before](g7-verified-20260908T102850Z-run1/d.before-restart.venue.json) and [after](g7-verified-20260908T102850Z-run1/d.after-restart.venue.json) paper journals show the same accepted order and one submission. These journals establish paper simulator behavior, not exchange execution.

For example, verify the published scene D export without credentials or a database:

```powershell
pnpm verify:receipt -- docs/evidence/demo/g7-verified-20260908T102850Z-run1/d.export.json
```

The [fresh-start result](g7-fresh-start.json) records a separate startup smoke check on the same code revision. A fresh GitHub clone of `main` checked out the review commit fetched from the local review checkout, installed the frozen lockfile, migrated a fresh database, built, and passed doctor. Real kernel and Vite processes then served readiness, a seeded scene A counterproposal, operator approval, background settlement and a verified full export through the frontend proxy. The result records 17 events, one replayed receipt, one command and one fill.

Historical evidence is unchanged. Recording/upload and entry submission remain owner work; these synthetic runs do not complete the separately documented integration qualifications.
