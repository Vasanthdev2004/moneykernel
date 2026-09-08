/**
 * Prepares one recording-friendly SHADOW proposal using a fresh Binance public
 * order-book observation. Funds stay virtual and execution stays paper-only.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DecisionResponseSchema, IdSchema } from "@moneykernel/contracts";
import { dec, mul, roundPriceToTick, toDecimalString } from "@moneykernel/domain";

const USAGE = "usage: pnpm demo:shadow -- --seed <seed-output.json> [--kernel http://127.0.0.1:8080]";

type Seed = { agents: Array<{ fixture_agent_id: string; token: string; lease_id: string }> };
type BookLevel = { price?: unknown; quantity?: unknown };

class ShadowDemoError extends Error {}

function parseOptions(): { seedPath: string; kernel: string } {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: { kernel: { type: "string", default: "http://127.0.0.1:8080" }, seed: { type: "string" } },
    });
    if (positionals.length > 0 || !values.seed) throw new Error();
    const url = new URL(values.kernel);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return { seedPath: values.seed, kernel: values.kernel.replace(/\/$/, "") };
  } catch {
    throw new ShadowDemoError(USAGE);
  }
}

function loadSeed(path: string): Seed {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Seed;
    if (
      !Array.isArray(parsed.agents) ||
      !parsed.agents.every(
        (agent) =>
          typeof agent.fixture_agent_id === "string" &&
          typeof agent.token === "string" &&
          agent.token.length > 0 &&
          IdSchema.safeParse(agent.lease_id).success,
      )
    ) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new ShadowDemoError("could not read a valid seed output file");
  }
}

async function readJson(
  url: string,
  options: RequestInit,
  expectedStatus: number,
  label: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(7_000) });
  } catch {
    throw new ShadowDemoError(`${label} could not reach the kernel`);
  }
  if (response.status !== expectedStatus) throw new ShadowDemoError(`${label} failed (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ShadowDemoError(`${label} returned invalid JSON`);
  }
  return body as Record<string, unknown>;
}

const { seedPath, kernel } = parseOptions();
const seed = loadSeed(seedPath);
const alpha = seed.agents.find((agent) => agent.fixture_agent_id === "agent_alpha");
if (!alpha) throw new ShadowDemoError("agent_alpha is missing from the seed output");
const authorization = { authorization: `Bearer ${alpha.token}` };

const context = await readJson(`${kernel}/v1/agent/context`, { headers: authorization }, 200, "live market context");
const account = context.account as { environment?: unknown } | undefined;
if (account?.environment !== "SHADOW") throw new ShadowDemoError("kernel is not running in SHADOW mode");
const observations = Array.isArray(context.observations) ? context.observations : [];
const observation = observations.find(
  (value) => value !== null && typeof value === "object" && (value as { symbol?: unknown }).symbol === "SOLUSDT",
) as
  | { snapshot_id?: unknown; source?: unknown; received_at?: unknown; best_bid?: BookLevel; best_ask?: BookLevel }
  | undefined;
if (
  observation?.source !== "BINANCE_PUBLIC_REST" ||
  !IdSchema.safeParse(observation.snapshot_id).success ||
  typeof observation.best_bid?.price !== "string" ||
  typeof observation.best_ask?.price !== "string" ||
  typeof observation.received_at !== "string"
) {
  throw new ShadowDemoError("fresh BINANCE_PUBLIC_REST SOLUSDT book data is unavailable");
}

// A 20 bps marketable limit remains inside MoneyKernel's 50 bps dispatch drift envelope.
// The kernel independently normalizes it again against the live symbol tick.
const limitPrice = toDecimalString(
  roundPriceToTick(mul(dec(observation.best_ask.price), dec("1.002")), dec("0.01"), "BUY"),
);
const intentResponse = await readJson(
  `${kernel}/v1/agent/intents`,
  {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/json",
      "idempotency-key": `shadow-recording-${Date.now()}`,
    },
    body: JSON.stringify({
      schema_version: "1",
      lease_id: alpha.lease_id,
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "50" },
      limit_price: limitPrice,
      observation_ids: [observation.snapshot_id],
      rationale: "Live Binance market observation; MoneyKernel must independently authorize and size the request.",
    }),
  },
  201,
  "live proposal",
);
let decision = DecisionResponseSchema.parse(intentResponse);
if (decision.provenance.execution_mode !== "SHADOW" || decision.candidate === null || decision.proposal_id === null) {
  throw new ShadowDemoError(`MoneyKernel did not create a SHADOW proposal (${decision.reason_codes.join(", ")})`);
}

for (let attempt = 0; attempt < 20 && decision.state === "COLLECTING"; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const readback = await readJson(
    `${kernel}/v1/agent/intents/${encodeURIComponent(decision.intent_id)}`,
    { headers: authorization },
    200,
    "proposal readback",
  );
  decision = DecisionResponseSchema.parse(readback);
}
if (decision.state !== "AWAITING_APPROVAL") {
  throw new ShadowDemoError(`proposal did not reach approval (${decision.state})`);
}
const candidate = decision.candidate;
if (candidate === null) throw new ShadowDemoError("proposal reached approval without an exact candidate");

console.log(`Live Binance SOLUSDT book · ${observation.received_at}`);
console.log(`Bid ${observation.best_bid.price} · Ask ${observation.best_ask.price} · BINANCE_PUBLIC_REST`);
console.log("Alpha requested 50 USDT of SOL using that observation.");
console.log(
  `MoneyKernel ${decision.outcome.toLowerCase()}: ${candidate.quantity} SOL @ ${candidate.limit_price} · ${candidate.total_quote_reserved} USDT reserved.`,
);
console.log("Open Approvals in the console to review and approve the exact virtual order.");
