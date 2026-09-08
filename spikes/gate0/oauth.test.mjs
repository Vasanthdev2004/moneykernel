import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import test from "node:test";
import * as url from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const sourceUrl = new URL("./oauth.ts", import.meta.url);
const source = stripTypeScriptTypes(readFileSync(sourceUrl, "utf8"));
const configuration = {
  resource: "https://resource.example/mcp",
  issuer: "https://issuer.example",
  client_id: "https://client.example/oauth.json",
};
const metadata = {
  issuer: configuration.issuer,
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  code_challenge_methods_supported: ["S256"],
};

function cachedTokens(expired = false) {
  return {
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    token_type: "Bearer",
    obtained_at: "2020-01-01T00:00:00.000Z",
    expires_at: expired ? "2020-01-01T01:00:00.000Z" : "2099-01-01T00:00:00.000Z",
    ...configuration,
  };
}

async function loadOAuth({ cached = cachedTokens(), discovered = metadata } = {}) {
  const requests = [];
  const writes = [];
  const unexpectedSideEffect = () => { throw new Error("unexpected browser, socket, or timer operation"); };
  const context = createContext({
    Buffer,
    URL,
    URLSearchParams,
    process: {
      platform: "win32",
      env: {
        MCP_ENDPOINT: configuration.resource,
        MCP_OAUTH_ISSUER: configuration.issuer,
        MCP_OAUTH_CLIENT_ID: configuration.client_id,
      },
    },
    console: { log: unexpectedSideEffect },
    setTimeout: unexpectedSideEffect,
    fetch: async (endpoint, options = {}) => {
      requests.push({ endpoint, ...options });
      if (requests.length === 1 && endpoint === `${configuration.issuer}/.well-known/oauth-authorization-server`) {
        return { ok: true, json: async () => discovered };
      }
      if (endpoint === metadata.token_endpoint && options.method === "POST") {
        return {
          ok: true,
          text: async () => JSON.stringify({ access_token: "synthetic-renewed-token", expires_in: 3600 }),
        };
      }
      throw new Error("unexpected network operation");
    },
  });
  const imports = {
    "node:crypto": crypto,
    "node:child_process": { spawn: unexpectedSideEffect },
    "node:fs": {
      existsSync: () => cached !== null,
      readFileSync: () => JSON.stringify(cached),
      mkdirSync: (...args) => writes.push({ kind: "mkdir", args }),
      writeFileSync: (...args) => writes.push({ kind: "write", args }),
    },
    "node:http": { createServer: unexpectedSideEffect },
    "node:path": path,
    "node:url": url,
  };
  const module = new SourceTextModule(source, {
    context,
    identifier: sourceUrl.href,
    initializeImportMeta(meta) { meta.url = sourceUrl.href; },
  });
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `unexpected import: ${specifier}`);
    const exports = imports[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { oauth: module.namespace, requests, writes };
}

for (const field of ["resource", "issuer", "client_id"]) {
  for (const expired of [false, true]) {
    test(`rejects ${expired ? "expired" : "fresh"} cached tokens with a different ${field}`, async () => {
      const cached = { ...cachedTokens(expired), [field]: "https://other.example" };
      const { oauth, requests, writes } = await loadOAuth({ cached });
      await assert.rejects(oauth.getAccessToken(), /stored OAuth tokens do not match configured/);
      assert.deepEqual(requests, []);
      assert.deepEqual(writes, []);
    });
  }

  test(`direct refresh rejects a different ${field} before discovery`, async () => {
    const { oauth, requests, writes } = await loadOAuth();
    await assert.rejects(
      oauth.refresh({ ...cachedTokens(), [field]: "https://other.example" }),
      /stored OAuth tokens do not match configured/,
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(writes, []);
  });
}

test("matching fresh cached tokens are returned without network or cache writes", async () => {
  const cached = cachedTokens();
  const { oauth, requests, writes } = await loadOAuth({ cached });
  assert.deepEqual(JSON.parse(JSON.stringify(await oauth.getAccessToken())), cached);
  assert.deepEqual(requests, []);
  assert.deepEqual(writes, []);
});

test("matching expired cached tokens refresh with the configured identity", async () => {
  const cached = cachedTokens(true);
  const { oauth, requests, writes } = await loadOAuth({ cached });
  const refreshed = await oauth.getAccessToken();
  assert.equal(refreshed.access_token, "synthetic-renewed-token");
  assert.equal(refreshed.refresh_token, cached.refresh_token);
  for (const [field, value] of Object.entries(configuration)) assert.equal(refreshed[field], value);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "POST");
  assert.deepEqual(Object.fromEntries(requests[1].body), {
    grant_type: "refresh_token",
    refresh_token: cached.refresh_token,
    client_id: configuration.client_id,
    resource: configuration.resource,
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].kind, "write");
  assert.equal(JSON.parse(writes[1].args[1]).access_token, "synthetic-renewed-token");
});

for (const operation of ["getAccessToken", "login"]) {
  test(`${operation} rejects mismatched discovered issuer before token exchange`, async () => {
    const { oauth, requests, writes } = await loadOAuth({
      cached: cachedTokens(true),
      discovered: { ...metadata, issuer: "https://other.example" },
    });
    await assert.rejects(oauth[operation](), /authorization server metadata issuer does not match configured issuer/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, undefined);
    assert.deepEqual(writes, []);
  });
}
