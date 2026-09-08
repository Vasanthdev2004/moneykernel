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
import { type DecisionResponse, DecisionResponseSchema, IdSchema } from "@moneykernel/contracts";

const USAGE = "usage: pnpm demo:scene -- <a|b|c|d> --seed <seed-output.json>";
let scene: string;
let kernel: string;
let seedPath: string;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { kernel: { type: "string", default: "http://127.0.0.1:8080" }, seed: { type: "string" } },
  });
  scene = (positionals[0] ?? "").toLowerCase();
  kernel = values.kernel ?? "http://127.0.0.1:8080";
  const path = values.seed ?? process.env.MK_SEED_JSON;
  if (positionals.length !== 1 || !["a", "b", "c", "d"].includes(scene) || !path) throw new Error();
  const url = new URL(kernel);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  kernel = kernel.replace(/\/$/, "");
  seedPath = path;
} catch {
  console.error(USAGE);
  process.exit(1);
}

type Seed = { agents: Array<{ fixture_agent_id: string; token: string; lease_id: string }> };
let seed: Seed;

/** Only controlled messages reach the recording terminal; never echo remote bodies, tokens, or seed contents. */
class SceneError extends Error {}

function loadSeed(): Seed {
  try {
    const raw = readFileSync(seedPath, "utf8");
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Seed;
    if (
      !Array.isArray(parsed.agents) ||
      !parsed.agents.every(
        (a) =>
          typeof a.fixture_agent_id === "string" &&
          typeof a.token === "string" &&
          a.token.length > 0 &&
          IdSchema.safeParse(a.lease_id).success,
      )
    )
      throw new Error();
    return parsed;
  } catch {
    throw new SceneError("could not read a valid seed output file");
  }
}

function agent(fixtureId: string) {
  const found = seed.agents.find((a) => a.fixture_agent_id === fixtureId);
  if (found === undefined) throw new Error(`${fixtureId} not in the seed output`);
  return found;
}

async function call(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  expected: number,
  label: string,
) {
  let res: Response;
  try {
    res = await fetch(`${kernel}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new SceneError(`${label} could not reach the kernel`);
  }
  if (res.status !== expected) throw new SceneError(`${label} failed (HTTP ${res.status})`);
  try {
    const value: unknown = await res.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new SceneError(`${label} returned invalid JSON`);
  }
}

async function observation(token: string, symbol: string): Promise<string> {
  const ctx = await call(
    "GET",
    "/v1/agent/context",
    undefined,
    { authorization: `Bearer ${token}` },
    200,
    "agent context",
  );
  const account = ctx.account as { environment?: unknown } | null;
  if (account?.environment !== "REPLAY") throw new SceneError("demo scenes require a REPLAY account");
  const observations = Array.isArray(ctx.observations) ? ctx.observations : [];
  const obs = observations.find(
    (o: unknown) => o !== null && typeof o === "object" && (o as { symbol?: unknown }).symbol === symbol,
  ) as { snapshot_id?: unknown } | undefined;
  const id = IdSchema.safeParse(obs?.snapshot_id);
  if (!id.success) throw new SceneError(`agent context has no valid observation for ${symbol}`);
  return id.data;
}

function decisionFrom(body: unknown): DecisionResponse {
  const parsed = DecisionResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.provenance.execution_mode !== "REPLAY") {
    throw new SceneError("intent response is not a valid REPLAY decision");
  }
  return parsed.data;
}

function expectCandidate(
  decision: DecisionResponse,
  outcome: DecisionResponse["outcome"],
  quantity: string,
  price: string,
): void {
  if (
    decision.outcome !== outcome ||
    decision.proposal_id === null ||
    !["COLLECTING", "AWAITING_APPROVAL", "CONFLICT_HELD"].includes(decision.state) ||
    decision.candidate?.quantity !== quantity ||
    decision.candidate.limit_price !== price
  ) {
    throw new SceneError("decision does not match the expected scene candidate; use the scene's fresh fixture");
  }
}

async function submit(fixtureId: string, key: string, intent: Record<string, unknown>) {
  const a = agent(fixtureId);
  const symbol = String(intent.symbol);
  const res = await call(
    "POST",
    "/v1/agent/intents",
    { schema_version: "1", lease_id: a.lease_id, ...intent, observation_ids: [await observation(a.token, symbol)] },
    { authorization: `Bearer ${a.token}`, "idempotency-key": key },
    201,
    "intent submission",
  );
  const decision = decisionFrom(res);
  const candidate = decision.candidate;
  if (
    candidate !== null &&
    (candidate.symbol !== intent.symbol ||
      candidate.side !== intent.side ||
      candidate.order_type !== intent.order_type ||
      !decision.authority.requires_operator_approval)
  ) {
    throw new SceneError("intent response candidate differs from the submitted order binding");
  }
  console.log(
    `${fixtureId} ${key}: HTTP 201 ${decision.outcome} ${decision.state}` +
      `${candidate ? ` candidate ${candidate.quantity} @ ${candidate.limit_price}` : ""} reasons=${JSON.stringify(decision.reason_codes.slice(0, 8))}`,
  );
  return decision;
}

function pause(message: string): Promise<void> {
  console.log(`\n>>> ${message}\n    (press Enter to continue)`);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("data", entered);
      process.stdin.off("end", ended);
      process.stdin.off("error", ended);
      process.stdin.pause();
    };
    const entered = () => {
      cleanup();
      resolve();
    };
    const ended = () => {
      cleanup();
      reject(new SceneError("input closed before confirmation; scene incomplete"));
    };
    if (process.stdin.readableEnded || process.stdin.destroyed) return ended();
    process.stdin.once("data", entered);
    process.stdin.once("end", ended);
    process.stdin.once("error", ended);
    process.stdin.resume();
  });
}

async function waitForConflict(fixtureId: string, intentId: string): Promise<void> {
  const token = agent(fixtureId).token;
  for (let attempt = 0; attempt < 20; attempt++) {
    const body = await call(
      "GET",
      `/v1/agent/intents/${encodeURIComponent(intentId)}`,
      undefined,
      { authorization: `Bearer ${token}` },
      200,
      "conflict readback",
    );
    const decision = decisionFrom(body);
    if (decision.intent_id !== intentId) throw new SceneError("conflict readback returned another intent");
    if (decision.state === "CONFLICT_HELD") return;
    if (!["COLLECTING", "AWAITING_APPROVAL"].includes(decision.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new SceneError("opposing proposals did not become CONFLICT_HELD; scene incomplete");
}

function expectQuarantined(decision: DecisionResponse): void {
  if (
    decision.outcome !== "DENY" ||
    decision.candidate !== null ||
    decision.proposal_id !== null ||
    !decision.reason_codes.includes("AGENT_QUARANTINED")
  ) {
    throw new SceneError("request was not denied for AGENT_QUARANTINED; scene incomplete");
  }
}

const stamp = Date.now().toString(36);

async function sceneA(): Promise<void> {
  console.log("Scene A: constrained acquisition. Alpha asks for 80 USDT of SOL against a 40 USDT lease.");
  const decision = await submit("agent_alpha", `demo-a-${stamp}`, {
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
    limit_price: "100",
  });
  expectCandidate(decision, "COUNTERPROPOSE", "0.27", "100");
  if (!decision.reason_codes.includes("SYMBOL_EXPOSURE_LIMIT") || decision.state === "CONFLICT_HELD") {
    throw new SceneError("scene A did not produce the expected exposure-limited proposal");
  }
  await pause(
    "Console: open the proposal, show request vs exact candidate (0.27 SOL), tick the confirmation, approve; watch ACCEPTED then FILL_RECONCILED.",
  );
}

async function sceneB(): Promise<void> {
  console.log("Scene B: opposing pending intents on BTCUSDT within one collection window.");
  const buy = await submit("agent_alpha", `demo-b-buy-${stamp}`, {
    symbol: "BTCUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "50" },
    limit_price: "100000",
  });
  expectCandidate(buy, "ALLOW_PROPOSAL", "0.0005", "100000");
  const sell = await submit("agent_inventory_guard", `demo-b-sell-${stamp}`, {
    symbol: "BTCUSDT",
    side: "SELL",
    order_type: "LIMIT_IOC",
    size: { kind: "BASE_QUANTITY", base_asset: "BTC", amount: "0.0002" },
    limit_price: "100000",
  });
  expectCandidate(sell, "ALLOW_PROPOSAL", "0.0002", "100000");
  await waitForConflict("agent_alpha", buy.intent_id);
  await waitForConflict("agent_inventory_guard", sell.intent_id);
  await pause(
    "Console: both CONFLICT_HELD in Conflict review; select one (or reject both); the winner becomes a new revision awaiting approval, the loser's holds are released.",
  );
}

async function sceneC(): Promise<void> {
  console.log("Scene C: scripted chaos burst, eleven distinct requests in seconds.");
  for (let i = 1; i <= 11; i += 1) {
    const decision = await submit("agent_chaos", `demo-c-${stamp}-${String(i).padStart(3, "0")}`, {
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "7" },
      limit_price: "100",
      rationale: `burst request ${i}`,
    });
    if (i === 11) expectQuarantined(decision);
    else if (decision.reason_codes.includes("AGENT_QUARANTINED")) {
      throw new SceneError("agent quarantined before request 11; use the scene's fresh fixture");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  await pause(
    "Console: agent QUARANTINED, CRITICAL incident, reserved quote back to 0, timeline AGENT_QUARANTINED. Next request stays denied:",
  );
  const later = await submit("agent_chaos", `demo-c-${stamp}-later`, {
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "7" },
    limit_price: "100",
    rationale: "after quarantine",
  });
  expectQuarantined(later);
}

async function sceneD(): Promise<void> {
  console.log(
    "Scene D: SYNTHETIC FAULT SCENARIO. Alpha asks for 20 USDT of SOL; the venue will drop the accepted response and block order queries until restart.",
  );
  const decision = await submit("agent_alpha", `demo-d-${stamp}`, {
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "20" },
    limit_price: "100",
  });
  expectCandidate(decision, "ALLOW_PROPOSAL", "0.2", "100");
  if (decision.state === "CONFLICT_HELD") throw new SceneError("scene D candidate is held in a conflict");
  const secret = process.env.OPERATOR_BOOTSTRAP_SECRET ?? "";
  if (secret.length === 0) throw new SceneError("scene D requires OPERATOR_BOOTSTRAP_SECRET");
  const login = await call("POST", "/v1/auth/session", { bootstrap_secret: secret }, {}, 201, "operator login");
  if (typeof login.session_token !== "string" || !/^mko_[A-Za-z0-9_-]{20,}$/.test(login.session_token)) {
    throw new SceneError("operator login returned no valid session");
  }
  const fault = await call(
    "POST",
    "/v1/demo/faults",
    { kind: "DROP_RESPONSE_AFTER_ACCEPT", proposal_id: decision.proposal_id, hold_queries_until_restart: true },
    { authorization: `Bearer ${login.session_token}`, "idempotency-key": `demo-d-fault-${stamp}` },
    201,
    "synthetic fault setup",
  );
  if (
    fault.kind !== "DROP_RESPONSE_AFTER_ACCEPT" ||
    fault.proposal_id !== decision.proposal_id ||
    fault.hold_queries_until_restart !== true ||
    typeof fault.client_order_id !== "string" ||
    !/^mk_[0-9a-f]{32}$/.test(fault.client_order_id)
  ) {
    throw new SceneError("synthetic fault setup returned an unexpected acknowledgement");
  }
  console.log(
    "fault armed: HTTP 201 SYNTHETIC FAULT SCENARIO: accepted response will be dropped; order queries unavailable until kernel restart.",
  );
  await pause(
    "Console: approve the exact candidate. The command becomes OUTCOME UNKNOWN with the amber banner and a CRITICAL incident. Then stop the kernel (Ctrl+C) and start it again with the same alias; log in; the same client order id is ACCEPTED, the order EXPIRED with 0.12 SOL filled, the incident resolved, the account PAUSED. Resume from the console.",
  );
}

const scenes: Record<string, () => Promise<void>> = { a: sceneA, b: sceneB, c: sceneC, d: sceneD };
Promise.resolve()
  .then(async () => {
    seed = loadSeed();
    await scenes[scene]?.();
  })
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error(error instanceof SceneError ? error.message : "demo scene failed; scene incomplete");
    process.exitCode = 1;
  })
  .finally(() => {
    process.stdin.destroy();
  });
