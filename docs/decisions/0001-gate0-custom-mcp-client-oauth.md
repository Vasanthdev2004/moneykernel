# 0001 — Gate 0: custom MCP client must authenticate with OAuth

Date: 2026-09-08

## Problem

The PRD (section 2.3) lists two unverified assumptions: that a custom TypeScript MCP client can read Binance Agent OS market context, and that its authentication behaviour is understood. The documentation describes market data as "public, no auth".

## Observation

An MCP `initialize` POST to `https://agent.binance.com/mcp/agentic` without a bearer token returns HTTP 401 with:

```
WWW-Authenticate: Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp"
```

The authorization server metadata at `https://agent.binance.com/.well-known/oauth-authorization-server` advertises `authorization_code` with PKCE S256, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, and no `registration_endpoint`.

So the "no auth" statement applies to the market-data scope on the consent screen, not to the transport. A custom client still needs a token to open the MCP session.

## Options

1. Use Claude Code's own MCP client (`claude mcp add ... --transport http`) and its interactive OAuth. Proves the endpoint works, but the MoneyKernel backend would still have no connection of its own, so it is not Gate 0 evidence for the product.
2. Dynamic client registration. Not offered by the server.
3. Client ID metadata document: host a JSON document at an HTTPS URL, use that URL as `client_id`, run authorization-code + PKCE with a loopback redirect. Supported by the server metadata.

## Decision

Option 3. The document lives at `docs/oauth-client.json` and is served by GitHub Pages at `https://vasanthdev2004.github.io/moneykernel/oauth-client.json`. The spike implements the flow by hand in `spikes/gate0/oauth.ts` rather than through the SDK's provider abstraction so that every parameter (`client_id`, `resource`, `redirect_uri`, PKCE, `state`) is explicit and reviewable. The MCP transport itself still comes from the official SDK, pinned at 1.30.0.

The operator performs login and consent in their own browser. The spike never handles Binance credentials; it receives only the authorization code on `http://127.0.0.1:8765/callback`.

## Consequences

- The SHADOW-mode adapter will need the same OAuth machinery plus refresh handling. Token storage must move out of a plain file before any deployment beyond a single local machine.
- No scope names are published. The first successful consent will reveal what the token actually grants; the manifest records that rather than assuming.
- If the authorization server rejects unknown metadata-document clients, Gate 0 falls to the PRD's "stop claiming Agent OS integration" branch and the gap is disclosed.

## Revisit when

Binance publishes scope names, a registration endpoint, or an API-key alternative for custom clients.
