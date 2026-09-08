# 0006 — G4 observation age, applicable filters, and model evidence

Date: 2026-09-08. Review base: `9a4e888`.

## Observed failures

- One REST depth request at 12:00:00 followed by a cache hit at 12:00:01 produced a new `received_at`. With a valid 500 ms freshness policy, the original snapshot was denied as stale while the cached copy of the same book obtained a counterproposal.
- Rules declaring `PRICE_FILTER.maxPrice=100.1` and `MAX_POSITION.maxPosition=0.01` produced no unsupported filters. The evaluator accepted a 0.249-unit candidate at 100.2. The parser discarded the price bounds and treated the account-position filter as irrelevant. It also treated percentage-price filters as covered by the kernel's book-price drift policy.
- Two malformed model replies with known usage became a failed trace with no usage, zero repair attempts, and no validation result.
- The historical supported-session evidence rebound an earlier proposal to a later context dump. Its quoted book differs from the referenced snapshot. This does not verify a model proposal generated from the claimed fresh context.

## Decisions

Cached depth retains the original request and receive timestamps. Cache hits may get new snapshot IDs but do not renew observation age, reset request latency, or extend cache expiry. A freshness policy shorter than the cache lifetime can deny that cached observation.

The symbol-rule contract and fixture schema gain optional `min_price` and `max_price` fields. Old fixture rules and stored snapshots without these fields remain unbounded on that dimension. REST rules must provide both fields, which participate in their content hash and survive snapshot assembly. The evaluator checks the normalized BUY or SELL limit against inclusive, enabled bounds using `FILTER_PRICE_RANGE`; zero disables the corresponding bound. A zero tick size disables tick rounding. `ENGINE_VERSION` is `0.1.2` because evaluation semantics changed. No database migration or wire schema-version change is required.

`PERCENT_PRICE`, `PERCENT_PRICE_BY_SIDE`, and `MAX_POSITION` are reported in `unsupported_filters` and deny proposals with `FILTER_UNSUPPORTED`. Their reference-price/window or account-position semantics are not replaced by a fresh best bid, a configurable drift allowance, or small virtual order sizes. Binance documents price bounds, percentage-price references, and the position test in its [official filter specification](https://developers.binance.com/en/docs/products/spot/filters). SHADOW market reads remain usable; symbols with unqualified applicable filters cannot currently produce an admissible proposal. REPLAY fixtures and symbols with qualified filters remain available. Testnet execution remains unqualified.

Provider failures carry known latency, repair count, validation failure, and token usage into `NO_PROPOSAL` traces. If a repair request fails before returning usage, the first response's known usage is retained; unavailable usage remains unknown. This metadata carries no raw provider response or credential, and failures still submit no intent.

All four historical model-run JSON artifacts remain unchanged. Their [evidence status](../evidence/model-runs/README.md) now distinguishes the demonstrated submission/paper execution from the unverified link between the fresh context and the model output. A replacement must be stored separately and retain the exact model input and unmodified output; an old response must not be rebound to newer observations to avoid freshness checks.

## Verification

Offline fake-fetch tests cover original cache timestamps/expiry, price-bound parsing, unsupported applicable filters, and retained failed-run metadata. Pure evaluator tests cover BUY and SELL limits after tick normalization, inclusive and disabled bounds, and disabled ticks. A fixture-to-snapshot test checks the new price fields and hash binding. These tests require no live credentials or provider requests.
