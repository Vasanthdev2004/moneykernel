# Gate 0 probe

This is local, read-only integration evidence tooling, not the MoneyKernel
runtime. No upstream tool has been qualified yet, so the reviewed read allowlist
is empty and `spike:call` refuses every tool by default.

Run these commands from `spikes/gate0`:

```text
pnpm typecheck
pnpm test
pnpm spike:list
```

The tests execute the actual TypeScript probe and OAuth module with mocked
network, browser, and token storage. They require no credentials. Node's VM
modules emit an experimental-feature warning.

To qualify a read operation after a successful connection:

1. Run `spike:list` and inspect the actual discovered definition in the local,
   gitignored `raw/tools.raw.json` capture. Review its behavior, description,
   input/output schemas, and annotations; a read-sounding name or `readOnlyHint`
   alone is insufficient.
2. Add its exact endpoint, name, and `definition_hash` from
   `out/tools-discovered.json` to `reviewed-read-tools.ts` through code review.
   Never generate this allowlist automatically from discovery.
3. Run `pnpm spike:call <discovered-name> <json-args>` for the reviewed read.
   A changed definition or endpoint requires a new review. Negative write
   annotations and recognized write names remain blocked.

Cached OAuth tokens must match the configured resource, issuer, and client ID
before reuse or refresh. A mismatch requires login for the selected identity;
it must not transfer an existing token to another configuration.

Each sample's `payload_hash` covers the complete MCP tool result using SHA-256
over recursively key-sorted JSON, including structured content and error status.
This replaces the original content-only hash. Raw captures and tokens stay local.

These checks support PRD INV-01/02/14/16 and the reviewed mapping, provenance,
and credential separation requirements in sections 13, 14, and 18. They do not
qualify a live MCP connection, Testnet execution, or the product kernel.
