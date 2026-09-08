/**
 * pnpm demo:scene -- <a|b|c|d> [--kernel http://127.0.0.1:8080]
 *
 * Agent side of the recorded demo (docs/demo-script.md). Run against a kernel started with the scene's fresh
 * alias and seeded with the scene's scenario (`pnpm demo:seed <scenario-id>` prints the tokens; this script
 * reads them from the seed output file it is given or from `MK_SEED_JSON`). The operator acts only in the
 * console. Nothing here approves, resolves, or resumes anything.
 *
 *   MONEYKERNEL_ACCOUNT_ALIAS=demo-a pnpm dev            # terminal 1
 *   pnpm demo:seed scenario-a-constrained-acquisition > .moneykernel/demo-a.seed.json
 *   pnpm demo:scene -- a --seed .moneykernel/demo-a.seed.json
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    kernel: { type: "string", default: "http://127.0.0.1:8080" },
    seed: { type: "string" },
  },
});
const scene = (positionals[0] ?? "").toLowerCase();
const kernel = values.kernel ?? "http://127.0.0.1:8080";
const seedPath = values.seed ?? process.env.MK_SEED_JSON;
if (!["a", "b", "c", "d"].includes(scene) || seedPath === undefined) {
  console.error("usage: pnpm demo:scene -- <a|b|c|d> --seed <seed-output.json>");
  process.exit(1);
}

type Seed = { agents: Array<{ fixture_agent_id: string; token: string; lease_id: string }> };
const raw = readFileSync(seedPath, "utf8");
const seed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Seed;

function agent(fixtureId: string) {
  const found = seed.agents.find((a) => a.fixture_agent_id === fixtureId);
  if (found === undefined) throw new Error(`${fixtureId} not in the seed output`);
  return found;
}

async function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${kernel}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function observation(token: string, symbol: string): Promise<string> {
  const ctx = await call("GET", "/v1/agent/context", undefined, { authorization: `Bearer ${token}` });
  const obs = (ctx.body.observations as Array<{ snapshot_id: string; symbol: string; best_bid: unknown }>).find(
    (o) => o.symbol === symbol,
  );
  if (obs === undefined) throw new Error(`no observation for ${symbol}: ${JSON.stringify(ctx.body)}`);
  return obs.snapshot_id;
}

async function submit(fixtureId: string, key: string, intent: Record<string, unknown>) {
  const a = agent(fixtureId);
  const symbol = String(intent.symbol);
  const res = await call(
    "POST",
    "/v1/agent/intents",
    { schema_version: "1", lease_id: a.lease_id, ...intent, observation_ids: [await observation(a.token, symbol)] },
    { authorization: `Bearer ${a.token}`, "idempotency-key": key },
  );
  const candidate = res.body.candidate as { quantity: string; limit_price: string } | null;
  console.log(
    `${fixtureId} ${key}: HTTP ${res.status} ${String(res.body.outcome)} ${String(res.body.state ?? "")}` +
      `${candidate ? ` candidate ${candidate.quantity} @ ${candidate.limit_price}` : ""} reasons=${JSON.stringify(res.body.reason_codes ?? [])}`,
  );
  return res.body;
}

function pause(message: string): Promise<void> {
  console.log(`\n>>> ${message}\n    (press Enter to continue)`);
  return new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}

const stamp = Date.now().toString(36);

async function sceneA(): Promise<void> {
  console.log("Scene A: constrained acquisition. Alpha asks for 80 USDT of SOL against a 40 USDT lease.");
  await submit("agent_alpha", `demo-a-${stamp}`, {
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
    limit_price: "100",
  });
  await pause(
    "Console: open the proposal, show request vs exact candidate (0.27 SOL), tick the confirmation, approve; watch ACCEPTED then FILL_RECONCILED.",
  );
}

async function sceneB(): Promise<void> {
  console.log("Scene B: opposing pending intents on BTCUSDT within one collection window.");
  await submit("agent_alpha", `demo-b-buy-${stamp}`, {
    symbol: "BTCUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "50" },
    limit_price: "100000",
  });
  await submit("agent_inventory_guard", `demo-b-sell-${stamp}`, {
    symbol: "BTCUSDT",
    side: "SELL",
    order_type: "LIMIT_IOC",
    size: { kind: "BASE_QUANTITY", base_asset: "BTC", amount: "0.0002" },
    limit_price: "100000",
  });
  await pause(
    "Console: both CONFLICT_HELD in Conflict review; select one (or reject both); the winner becomes a new revision awaiting approval, the loser's holds are released.",
  );
}

async function sceneC(): Promise<void> {
  console.log("Scene C: scripted chaos burst, eleven distinct requests in seconds.");
  for (let i = 1; i <= 11; i += 1) {
    await submit("agent_chaos", `demo-c-${stamp}-${String(i).padStart(3, "0")}`, {
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "7" },
      limit_price: "100",
      rationale: `burst request ${i}`,
    });
    await new Promise((r) => setTimeout(r, 150));
  }
  await pause(
    "Console: agent QUARANTINED, CRITICAL incident, reserved quote back to 0, timeline AGENT_QUARANTINED. Next request stays denied:",
  );
  await submit("agent_chaos", `demo-c-${stamp}-later`, {
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "7" },
    limit_price: "100",
    rationale: "after quarantine",
  });
}

async function sceneD(): Promise<void> {
  console.log(
    "Scene D: SYNTHETIC FAULT SCENARIO. Alpha asks for 20 USDT of SOL; the venue will accept and drop the response.",
  );
  const decision = await submit("agent_alpha", `demo-d-${stamp}`, {
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "20" },
    limit_price: "100",
  });
  const secret = process.env.OPERATOR_BOOTSTRAP_SECRET ?? "";
  const login = await call("POST", "/v1/auth/session", { bootstrap_secret: secret }, {});
  const fault = await call(
    "POST",
    "/v1/demo/faults",
    { kind: "DROP_RESPONSE_AFTER_ACCEPT", proposal_id: decision.proposal_id },
    { authorization: `Bearer ${String(login.body.session_token)}`, "idempotency-key": `demo-d-fault-${stamp}` },
  );
  console.log(`fault armed: HTTP ${fault.status} ${String(fault.body.note ?? JSON.stringify(fault.body))}`);
  await pause(
    "Console: approve the exact candidate. The command becomes OUTCOME UNKNOWN with the amber banner and a CRITICAL incident. Then stop the kernel (Ctrl+C) and start it again with the same alias; log in; the same client order id is ACCEPTED, the order EXPIRED with 0.12 SOL filled, the incident resolved, the account PAUSED. Resume from the console.",
  );
}

const scenes: Record<string, () => Promise<void>> = { a: sceneA, b: sceneB, c: sceneC, d: sceneD };
scenes[scene]?.()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
