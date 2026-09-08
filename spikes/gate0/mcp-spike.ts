/**
 * MoneyKernel Gate 0 integration spike (prd.md section 2.4).
 *
 * Read-only probe of the documented Binance MCP endpoint. It performs the MCP
 * initialize handshake, lists tools, and on explicit request calls ONE tool
 * that is classified read-only. It refuses to call anything that looks like a
 * write. No upstream tool name is guessed: a call must name a tool that the
 * server itself listed.
 *
 * Raw responses go to ./raw (gitignored). Sanitized summaries go to ./out.
 * This is throwaway evidence tooling, not product runtime code.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(HERE, "raw");
const OUT_DIR = join(HERE, "out");
const ENDPOINT = process.env.MCP_ENDPOINT ?? "https://agent.binance.com/mcp/agentic";
const CLIENT_INFO = { name: "moneykernel-gate0-spike", version: "0.0.1" };

const DECIMAL_STRING_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const READ_NAME_RE =
  /(ticker|price|depth|book|kline|candle|exchange|symbol|time|info|funding|market|stats|avg|premium|index|trades?$)/i;
const WRITE_NAME_RE =
  /(place|create|submit|cancel|transfer|withdraw|buy|sell|borrow|repay|redeem|subscribe|convert|new_?order|order_?new|close|modify|amend|replace)/i;

type ToolLike = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
};

type NumericField = { path: string; kind: "DECIMAL_STRING" | "JSON_NUMBER"; value: string };

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, sortKeys(rec[k])]),
    );
  }
  return value;
}
const canonical = (value: unknown): string => JSON.stringify(sortKeys(value));
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const nowIso = (): string => new Date().toISOString();

function sdkVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
    return String(pkg.version);
  } catch {
    return "UNKNOWN";
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function classify(tool: ToolLike): "READ" | "WRITE" | "UNKNOWN" {
  const ro = tool.annotations?.readOnlyHint;
  if (ro === false || tool.annotations?.destructiveHint === true) return "WRITE";
  if (WRITE_NAME_RE.test(tool.name)) return "WRITE";
  if (ro === true) return "READ";
  if (READ_NAME_RE.test(tool.name)) return "READ";
  return "UNKNOWN";
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
  const client = new Client(CLIENT_INFO);
  const requestStartedAt = nowIso();
  const t = performance.now();
  await client.connect(transport);
  const receivedAt = nowIso();
  const tx = transport as unknown as { protocolVersion?: string; sessionId?: string };
  const handshake = {
    endpoint: ENDPOINT,
    transport: "streamable-http",
    client_info: CLIENT_INFO,
    sdk_version: sdkVersion(),
    request_started_at: requestStartedAt,
    received_at: receivedAt,
    latency_ms: Math.round(performance.now() - t),
    negotiated_protocol_version: tx.protocolVersion ?? null,
    session_id_present: Boolean(tx.sessionId),
    server_info: client.getServerVersion() ?? null,
    server_capabilities: client.getServerCapabilities() ?? null,
    server_instructions: client.getInstructions() ?? null,
  };
  return { client, handshake };
}

async function listAllTools(client: Client): Promise<ToolLike[]> {
  const tools: ToolLike[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as ToolLike[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function walk(v: unknown, path: string, out: NumericField[]): void {
  if (Array.isArray(v)) {
    v.slice(0, 5).forEach((x, i) => walk(x, `${path}[${i}]`, out));
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`, out);
    return;
  }
  if (typeof v === "number") out.push({ path, kind: "JSON_NUMBER", value: String(v) });
  else if (typeof v === "string" && DECIMAL_STRING_RE.test(v)) out.push({ path, kind: "DECIMAL_STRING", value: v });
}

function truncate(v: unknown): unknown {
  if (Array.isArray(v)) {
    const head = v.slice(0, 5).map(truncate);
    return v.length > 5 ? [...head, { _truncated_items: v.length - 5 }] : head;
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, truncate(x)]));
  }
  if (typeof v === "string" && v.length > 300) return v.slice(0, 300) + "...";
  return v;
}

function analyze(source: string, value: unknown) {
  const fields: NumericField[] = [];
  walk(value, "$", fields);
  const jsonNumbers = fields.filter((f) => f.kind === "JSON_NUMBER").length;
  return {
    status: fields.length ? "DETERMINISTIC_JSON" : "JSON_WITHOUT_NUMERIC_FIELDS",
    source,
    numeric_field_count: fields.length,
    decimal_string_count: fields.length - jsonNumbers,
    json_number_count: jsonNumbers,
    note:
      jsonNumbers > 0
        ? "JSON numbers present: production parser must read them losslessly from raw text before decimal use"
        : "all numeric fields arrive as decimal strings",
    numeric_fields: fields.slice(0, 40),
    payload_excerpt: truncate(value),
  };
}

function parseResult(result: { content?: unknown; structuredContent?: unknown }) {
  if (result.structuredContent !== undefined) return analyze("structuredContent", result.structuredContent);
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  try {
    return analyze("content[text] parsed as JSON", JSON.parse(text));
  } catch {
    return {
      status: "PROSE_ONLY",
      source: "content[text]",
      excerpt: text.slice(0, 500),
      numeric_fields: [] as NumericField[],
    };
  }
}

async function cmdList(): Promise<void> {
  const { client, handshake } = await connect();
  const t0 = nowIso();
  const t = performance.now();
  const tools = await listAllTools(client);
  const listing = {
    request_started_at: t0,
    received_at: nowIso(),
    latency_ms: Math.round(performance.now() - t),
    tool_count: tools.length,
  };
  await client.close();

  writeJson(join(RAW_DIR, "handshake.raw.json"), handshake);
  writeJson(join(RAW_DIR, "tools.raw.json"), tools);

  const discovered = tools.map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    classification: classify(tool),
    annotations: tool.annotations ?? null,
    description_excerpt: (tool.description ?? "").slice(0, 240),
    input_schema_hash: sha256(canonical(tool.inputSchema ?? null)),
    input_required: tool.inputSchema?.required ?? [],
    input_properties: Object.keys(tool.inputSchema?.properties ?? {}),
    has_output_schema: tool.outputSchema !== undefined,
  }));
  writeJson(join(OUT_DIR, "tools-discovered.json"), { handshake, listing, tools: discovered });

  console.log(`\nendpoint   ${ENDPOINT}`);
  console.log(`protocol   ${handshake.negotiated_protocol_version}`);
  console.log(`server     ${JSON.stringify(handshake.server_info)}`);
  console.log(`caps       ${JSON.stringify(handshake.server_capabilities)}`);
  console.log(`handshake  ${handshake.latency_ms} ms; tools/list ${listing.latency_ms} ms; ${tools.length} tools\n`);
  for (const d of discovered) {
    console.log(
      `${d.classification.padEnd(8)} ${d.name.padEnd(42)} required=[${d.input_required.join(",")}] props=[${d.input_properties.join(",")}]`,
    );
  }
  console.log(`\nwrote ${join(OUT_DIR, "tools-discovered.json")}`);
}

async function cmdCall(name: string, argsJson: string | undefined): Promise<void> {
  const args = JSON.parse(argsJson ?? "{}") as Record<string, unknown>;
  const { client, handshake } = await connect();
  const tools = await listAllTools(client);
  const tool = tools.find((x) => x.name === name);
  if (!tool) throw new Error(`tool "${name}" is not in the server's tools/list; refusing to guess`);
  if (classify(tool) !== "READ" || WRITE_NAME_RE.test(tool.name)) {
    throw new Error(`tool "${name}" is not classified read-only; the spike refuses to call it`);
  }
  const requestStartedAt = nowIso();
  const t = performance.now();
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const receivedAt = nowIso();
  const latency = Math.round(performance.now() - t);
  await client.close();

  writeJson(join(RAW_DIR, `call-${name}.raw.json`), { args, result });

  const sample = {
    tool: name,
    arguments: args,
    input_schema_hash: sha256(canonical(tool.inputSchema ?? null)),
    request_started_at: requestStartedAt,
    received_at: receivedAt,
    latency_ms: latency,
    is_error: result.isError ?? false,
    content_kinds: ((result.content ?? []) as Array<{ type: string }>).map((c) => c.type),
    has_structured_content: result.structuredContent !== undefined,
    payload_hash: sha256(canonical(result.content ?? null)),
    parse: parseResult(result),
  };
  writeJson(join(OUT_DIR, `sample-${name}.json`), { handshake, sample });

  console.log(`\ntool        ${name}`);
  console.log(`args        ${JSON.stringify(args)}`);
  console.log(`timing      started ${requestStartedAt} received ${receivedAt} (${latency} ms)`);
  console.log(`is_error    ${sample.is_error}`);
  console.log(`parse       ${sample.parse.status}; numeric=${sample.parse.numeric_fields.length}`);
  console.log(JSON.stringify(sample.parse, null, 2).slice(0, 4000));
  console.log(`\nwrote ${join(OUT_DIR, `sample-${name}.json`)}`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === "list") await cmdList();
  else if (cmd === "call" && a) await cmdCall(a, b);
  else {
    console.error("usage: tsx mcp-spike.ts list | call <tool-name> <json-args>");
    process.exit(2);
  }
} catch (err) {
  const e = err as Error & { cause?: unknown; code?: unknown };
  console.error(`SPIKE FAILED: ${e.name}: ${e.message}`);
  if (e.code !== undefined) console.error(`code: ${String(e.code)}`);
  if (e.cause !== undefined) console.error(`cause: ${String(e.cause)}`);
  process.exit(1);
}
