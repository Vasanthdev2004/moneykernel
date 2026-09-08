# Independent supported-session proposal evidence

On 2026-09-08 the Codex reviewer in this conversation read the exact context in
`context.json`, then authored the raw proposal in `session-proposal.json`.
The context hash and observation ID were retained unchanged. The rationale's
103.04 ask, 409.327 SOL depth, and 40 USDT lease match that context.

The review used a fresh SHADOW account in disposable PostgreSQL, real Binance
public REST reads, and virtual funds. A temporary local test helper passed the
stored context and proposal through `AgentSessionProvider` and `runOnce`; its
client invoked the normal authenticated agent HTTP handlers through Fastify
injection. It did not bypass validation or change the clock/freshness policy.

The observation arrived at 08:37:23.654Z; the runner finished at 08:37:38.176Z.
The kernel correctly returned `DENY` with `FILTER_UNSUPPORTED` and
`STALE_MARKET_DATA`: the session took longer than the 5-second freshness limit,
and the symbol has filters this version has not qualified. `receipt.json`
records the durable refusal and a command count of zero. No approval or order
was created, and the context was not refreshed to conceal the delay.

This demonstrates an actual model-authored, context-bound proposal entering the
kernel and being refused safely. It does not demonstrate a successfully
approved trade, a live API provider call, or Binance MCP access. The trace's
`latency_ms: 0` measures the file-backed provider, not the model/session's elapsed
time above. Token usage is unavailable. The seeded agent's receipt label stays
`SCRIPTED` under decision 0003, while the runner records
`SUPPORTED_AGENT_SESSION`; receipt-to-run provenance remains a G6 task.
