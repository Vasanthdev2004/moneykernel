import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const sourceUrl = new URL("./mcp-spike.ts", import.meta.url);
const source = stripTypeScriptTypes(readFileSync(sourceUrl, "utf8"));
const endpoint = "https://agent.binance.com/mcp/agentic";
const marketTool = {
  name: "get_market_data",
  description: "Read a market price (synthetic test tool, not an upstream identifier).",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function reviewed(tool, resource = endpoint) {
  return {
    endpoint: resource,
    name: tool.name,
    definition_hash: createHash("sha256").update(JSON.stringify(canonical(tool))).digest("hex"),
  };
}

// Execute the actual CLI with all IO replaced. No token files or network are used.
async function probe({ tool = marketTool, result = { content: [] }, mapping = [], command = "call" } = {}) {
  const calls = [];
  const writes = new Map();
  let closes = 0;
  const processStub = { argv: ["node", fileURLToPath(sourceUrl), command, tool.name, "{}"], exitCode: 0 };
  const context = vm.createContext({
    URL, performance, process: processStub,
    console: { log() {}, error() {} },
  });
  class Client {
    async connect() {}
    async listTools() { return { tools: [tool] }; }
    async callTool(input) { calls.push(input); return result; }
    async close() { closes++; }
    getServerVersion() { return { name: "mock", version: "1" }; }
    getServerCapabilities() { return { tools: {} }; }
    getInstructions() { return ""; }
  }
  class Transport { protocolVersion = "mock"; sessionId = "mock"; }
  const bindings = {
    "@modelcontextprotocol/sdk/client/index.js": { Client },
    "@modelcontextprotocol/sdk/client/streamableHttp.js": { StreamableHTTPClientTransport: Transport },
    "node:crypto": { createHash },
    "node:fs": {
      mkdirSync() {},
      readFileSync() { return '{"version":"1.30.0"}'; },
      writeFileSync(path, text) { writes.set(path, JSON.parse(text)); },
    },
    "node:path": { dirname, join },
    "node:url": { fileURLToPath },
    "./oauth.ts": {
      CLIENT_ID: "mock-client", RESOURCE: endpoint, describe() {},
      async getAccessToken() { return null; },
      async login() { throw new Error("Unexpected login in offline test"); },
    },
    "./reviewed-read-tools.ts": { REVIEWED_READ_TOOLS: mapping },
  };
  const mod = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) { meta.url = sourceUrl.href; },
  });
  await mod.link((specifier) => {
    const values = bindings[specifier];
    assert.ok(values, `Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  return {
    calls, closes, exitCode: processStub.exitCode,
    sample: [...writes.entries()].find(([path]) => path.endsWith(`sample-${tool.name}.json`))?.[1].sample,
    listing: [...writes.entries()].find(([path]) => path.endsWith("tools-discovered.json"))?.[1],
  };
}

for (const tool of [
  { ...marketTool, name: "execute_trade", annotations: undefined },
  { ...marketTool, name: "execute_trade" },
  marketTool,
]) {
  test(`unreviewed ${tool.name}, readOnlyHint=${tool.annotations?.readOnlyHint}, never invokes a tool`, async () => {
    const run = await probe({ tool });
    assert.equal(run.calls.length, 0);
    assert.equal(run.exitCode, 1);
    assert.equal(run.closes, 1);
  });
}

test("an exact reviewed definition and endpoint permit one explicit read", async () => {
  const run = await probe({ mapping: [reviewed(marketTool)] });
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].name, marketTool.name);
  assert.equal(run.exitCode, 0);
  assert.equal(run.closes, 1);
});

test("a review for another endpoint grants no authority", async () => {
  const run = await probe({ mapping: [reviewed(marketTool, "https://other.example/mcp")] });
  assert.equal(run.calls.length, 0);
  assert.equal(run.exitCode, 1);
});

for (const change of [
  { description: "Changed tool behavior" },
  { inputSchema: { type: "object", properties: { action: { type: "string" } } } },
  { outputSchema: { type: "object" } },
  { annotations: { readOnlyHint: true, destructiveHint: true } },
]) {
  test(`a changed ${Object.keys(change)[0]} invalidates the reviewed mapping`, async () => {
    const run = await probe({ tool: { ...marketTool, ...change }, mapping: [reviewed(marketTool)] });
    assert.equal(run.calls.length, 0);
    assert.equal(run.exitCode, 1);
  });
}

test("write declarations remain blocked even with a matching reviewed entry", async () => {
  for (const tool of [
    { ...marketTool, name: "create_order" },
    { ...marketTool, annotations: { readOnlyHint: false } },
    { ...marketTool, annotations: { destructiveHint: true } },
  ]) {
    const run = await probe({ tool, mapping: [reviewed(tool)] });
    assert.equal(run.calls.length, 0);
  }
});

test("discovery reports the full definition fingerprint without invoking tools", async () => {
  const run = await probe({ command: "list" });
  assert.equal(run.calls.length, 0);
  assert.equal(run.listing.tools[0].definition_hash, reviewed(marketTool).definition_hash);
  assert.equal(run.listing.tools[0].classification, "UNKNOWN");
});

test("payload hash changes with structured data, content, or error status", async () => {
  const hashes = [];
  for (const result of [
    { content: [], structuredContent: { price: "100" }, isError: false },
    { content: [], structuredContent: { price: "200" }, isError: false },
    { content: [{ type: "text", text: "changed" }], structuredContent: { price: "100" }, isError: false },
    { content: [], structuredContent: { price: "100" }, isError: true },
  ]) {
    const run = await probe({ mapping: [reviewed(marketTool)], result });
    hashes.push(run.sample.payload_hash);
  }
  assert.equal(new Set(hashes).size, 4);
});

test("equivalent result objects hash identically regardless of key order", async () => {
  const first = await probe({ mapping: [reviewed(marketTool)], result: { content: [], structuredContent: { price: "100", symbol: "BTCUSDT" } } });
  const second = await probe({ mapping: [reviewed(marketTool)], result: { structuredContent: { symbol: "BTCUSDT", price: "100" }, content: [] } });
  assert.equal(first.sample.payload_hash, second.sample.payload_hash);
});
