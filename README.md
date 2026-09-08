# MoneyKernel

**Give AI agents capital, not blind trust.**

MoneyKernel is a deterministic capital-control gateway for AI trading agents. Agents propose trades; the kernel checks lease authority, reserves resources atomically, holds opposing pending intents for human review, requires exact single-use human approval, dispatches once, reconciles what actually happened, and records a verifiable decision receipt.

Built for the Binance Agent OS Mini Hackathon (Track A) as a v0.1 prototype.

## Status

Gate 0 (integration and feasibility spike) is in progress. No runnable product code exists yet.

- `prd.md` is the full product requirements document, technical design, and delivery plan.
- `docs/integration-manifest.json` will hold the recorded Binance Agent OS integration evidence once the spike completes.
- `spikes/gate0/` is throwaway read-only probe tooling, not product runtime code.

## Non-negotiables (from the PRD)

- Safety authority is deterministic application code, never an LLM.
- Default mode is REPLAY: offline fixtures, virtual funds, no exchange credentials.
- SHADOW mode uses real Binance MCP market observations with virtual funds and simulated execution.
- Binance Spot Testnet execution is a P1 extension, only after qualification.
- Mainnet order execution is explicitly excluded from v0.1.
- Only order primitive: Spot LIMIT with IOC time-in-force.

## Planned layout

See `prd.md` section 12.4. The pnpm workspace (`apps/kernel`, `apps/web`, `apps/agents`, `packages/contracts|domain|persistence|integrations`) is created in Gate 1.

## License

Not yet selected by the product owner. There is no LICENSE file in this repository yet.
