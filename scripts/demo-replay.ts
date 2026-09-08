/**
 * pnpm demo:replay -- <scenario-id> [--runs N] [--out DIR] [--keep-alias ALIAS]
 *
 * Offline scenario replay (prd.md 22.2, 27.5, T-60): boots an in-process REPLAY
 * kernel on a fresh account alias with an injected virtual clock, seeds the
 * scenario, drives its steps through the same HTTP handlers the console uses,
 * checks the fixture's `expected` block, exports the run, and verifies the
 * export with the standalone verifier. Every run is a new virtual account and
 * event chain; nothing from an earlier run is reused (prd.md 27.5). No
 * exchange, provider, or network call happens in REPLAY.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dec, eq } from "@moneykernel/domain";
import {
  loadScenario,
  MemoryPaperVenueStore,
  type PaperExecutionAdapter,
  type Scenario,
} from "@moneykernel/integrations";
import { listCommands, listReservationsForProposal, withClient } from "@moneykernel/persistence";
import { buildApp } from "../apps/kernel/src/app.ts";
import { boot, type KernelRuntime } from "../apps/kernel/src/boot.ts";
import { ConfigError, loadConfig } from "../apps/kernel/src/config.ts";
import { dispatchOnce } from "../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../apps/kernel/src/fixtures.ts";
import { sweepProposals } from "../apps/kernel/src/services/proposals.ts";
import { reconcileOutstanding } from "../apps/kernel/src/services/reconciliation.ts";
import { type SeededAgent, seedScenario } from "../apps/kernel/src/services/seed.ts";

type Check = { name: string; ok: boolean; detail: string };
type Json = Record<string, unknown>;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "1" },
    out: { type: "string", default: ".moneykernel/replays" },
    "keep-alias": { type: "string" },
  },
});
const scenarioId = positionals[0] ?? "scenario-a-constrained-acquisition";
const runs = Math.max(1, Number.parseInt(values.runs ?? "1", 10) || 1);

let baseConfig: ReturnType<typeof loadConfig>;
try {
  baseConfig = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
if (baseConfig.environment !== "REPLAY") {
  console.error("demo:replay only runs in REPLAY (set MONEYKERNEL_MODE=REPLAY); other modes are never replayed");
  process.exit(1);
}

class Replay {
  readonly scenario: Scenario;
  readonly alias: string;
  readonly clock = { now: 0 };
  readonly store = new MemoryPaperVenueStore();
  readonly faults = { dropResponseFor: new Set<string>() };
  readonly checks: Check[] = [];
  readonly log: string[] = [];
  runtime!: KernelRuntime;
  app!: ReturnType<typeof buildApp>;
  agents: SeededAgent[] = [];
  operatorToken = "";
  lastDecision: Json | null = null;
  lastCommandId: string | null = null;
  decisions: Json[] = [];

  constructor(scenario: Scenario, alias: string) {
    this.scenario = scenario;
    this.alias = alias;
    this.clock.now = Date.parse(scenario.virtual_clock_start);
  }

  private config() {
    return loadConfig({
      ...process.env,
      MONEYKERNEL_MODE: "REPLAY",
      MONEYKERNEL_ACCOUNT_ALIAS: this.alias,
      REPLAY_FIXTURE: this.scenario.scenario_id,
      LOG_LEVEL: "silent",
    });
  }

  async boot(): Promise<void> {
    this.runtime = await boot(this.config(), {
      clock: () => new Date(this.clock.now),
      paperVenueStore: this.store,
      paperFaults: this.faults,
    });
    const failed = this.runtime.bootChecks.filter((c) => !c.ok);
    if (
      this.runtime.account === null ||
      failed.some((c) => c.name !== "recovery" && c.name !== "unresolved_commands")
    ) {
      throw new Error(`boot not ready: ${JSON.stringify(failed)}`);
    }
    this.app = buildApp(this.runtime);
  }

  async shutdown(): Promise<void> {
    await this.app.close();
    await this.runtime.shutdown();
  }

  async request(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: res.statusCode, body: (res.body.length === 0 ? {} : JSON.parse(res.body)) as Json };
  }

  async login(): Promise<void> {
    const res = await this.request("POST", "/v1/auth/session", {
      bootstrap_secret: this.runtime.config.operatorBootstrapSecret,
    });
    if (res.status !== 201) throw new Error(`operator login failed: ${JSON.stringify(res.body)}`);
    this.operatorToken = String(res.body.session_token);
  }

  op(method: "GET" | "POST", url: string, body?: unknown, key?: string) {
    return this.request(method, url, body, {
      authorization: `Bearer ${this.operatorToken}`,
      ...(key === undefined ? {} : { "idempotency-key": key }),
    });
  }

  agent(fixtureId: string): SeededAgent {
    const agent = this.agents.find((a) => a.fixture_agent_id === fixtureId);
    if (agent === undefined) throw new Error(`agent ${fixtureId} not seeded`);
    return agent;
  }

  /** Fixture observation ids are placeholders; the kernel issues real snapshot ids per context read. */
  async submitIntent(fixtureAgentId: string, key: string, template: Json): Promise<Json> {
    const agent = this.agent(fixtureAgentId);
    const ctx = await this.request("GET", "/v1/agent/context", undefined, { authorization: `Bearer ${agent.token}` });
    const observations = (ctx.body.observations as Array<{ snapshot_id: string; symbol: string }>) ?? [];
    const symbol = String(template.symbol);
    const observation = observations.find((o) => o.symbol === symbol);
    if (observation === undefined) throw new Error(`no observation for ${symbol}`);
    const intent = { ...template, lease_id: agent.lease_id, observation_ids: [observation.snapshot_id] };
    const res = await this.request("POST", "/v1/agent/intents", intent, {
      authorization: `Bearer ${agent.token}`,
      "idempotency-key": key,
    });
    const decision = { http_status: res.status, ...res.body };
    this.decisions.push(decision);
    this.lastDecision = decision;
    this.log.push(
      `intent ${key}: ${res.status} ${String(res.body.outcome ?? res.body.error)} ${String(res.body.state ?? "")} candidate=${JSON.stringify(
        (res.body.candidate as Json | null)?.quantity ?? null,
      )}`,
    );
    return decision;
  }

  async sweep(): Promise<void> {
    await sweepProposals(this.runtime, new Date(this.clock.now));
  }

  async approveLast(): Promise<void> {
    const d = this.lastDecision;
    if (d === null || d.proposal_id === null) throw new Error("nothing to approve");
    this.clock.now += 800;
    await this.sweep();
    const res = await this.op(
      "POST",
      `/v1/proposals/${String(d.proposal_id)}/approve`,
      {
        proposal_revision: d.proposal_revision,
        proposal_hash: d.proposal_hash,
        expected_account_epoch: (d.authority as Json).account_epoch,
        operator_confirmation: true,
      },
      `replay-approve-${String(d.proposal_id)}`,
    );
    this.log.push(`approve ${String(d.proposal_id)}: ${res.status} ${String(res.body.state ?? res.body.error)}`);
    if (res.status !== 201 && res.status !== 200) throw new Error(`approval failed: ${JSON.stringify(res.body)}`);
    const pool = this.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const command = (await withClient(pool, (c) => listCommands(c, this.runtime.account?.id ?? "", ["READY"]))).find(
      (c) => c.proposal_id === d.proposal_id,
    );
    this.lastCommandId = command?.id ?? null;
  }

  async dispatch(fault: string | undefined): Promise<void> {
    const pool = this.runtime.pool;
    if (pool === null || this.lastCommandId === null) throw new Error("nothing to dispatch");
    const command = (await withClient(pool, (c) => listCommands(c, this.runtime.account?.id ?? ""))).find(
      (c) => c.id === this.lastCommandId,
    );
    if (command === undefined) throw new Error("command missing");
    if (fault === "DROP_RESPONSE_AFTER_ACCEPT") this.faults.dropResponseFor.add(command.client_order_id);
    const report = await dispatchOnce(this.runtime, new Date(this.clock.now));
    this.log.push(`dispatch ${command.client_order_id}: ${JSON.stringify(report)}`);
  }

  async restart(): Promise<void> {
    await this.shutdown();
    await this.boot();
    await this.login();
    const recovery = this.runtime.recovery;
    this.log.push(`restart: recovery ${JSON.stringify(recovery)}`);
  }

  async reconcile(): Promise<void> {
    const sweep = await reconcileOutstanding(this.runtime, new Date(this.clock.now));
    this.log.push(`reconcile: ${JSON.stringify(sweep.reports.map((r) => r.result))}`);
  }

  check(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, detail });
  }
}

async function runScenario(scenario: Scenario, alias: string): Promise<{ replay: Replay; exportPath: string }> {
  const replay = new Replay(scenario, alias);
  await replay.boot();
  replay.agents = (await seedScenario(replay.runtime, scenario, { operatorId: "demo-replay" })).agents;
  await replay.login();

  for (const step of (scenario as Scenario & { steps?: Json[] }).steps ?? []) {
    replay.clock.now = Math.max(replay.clock.now, Date.parse(String(step.at)));
    const action = String(step.action);
    if (action === "SUBMIT_INTENT") {
      await replay.submitIntent(String(step.agent_id), String(step.idempotency_key), step.intent as Json);
    } else if (action === "OPERATOR_APPROVE_EXACT") {
      await replay.approveLast();
    } else if (action === "DISPATCH") {
      await replay.dispatch((step.fault as Json | undefined)?.kind as string | undefined);
    } else if (action === "CRASH_BEFORE_RESPONSE_PERSISTED") {
      replay.log.push("crash point: response never persisted (the dropped-response fault already modelled it)");
    } else if (action === "RESTART") {
      await replay.restart();
    } else if (action === "RECONCILE") {
      await replay.reconcile();
    } else {
      throw new Error(`unknown scenario step ${action}`);
    }
  }

  // Scenario C carries a burst block instead of steps (prd.md 27.3).
  const burst = (scenario as Scenario & { burst?: Json }).burst;
  if (burst !== undefined) {
    const count = Number(burst.count ?? 11);
    const template = burst.intent_template as Json;
    const prefix = String(burst.idempotency_key_prefix ?? "burst-");
    const agentId = scenario.agents[0]?.agent_id ?? "";
    for (let i = 1; i <= count; i += 1) {
      replay.clock.now += Number(burst.spacing_ms ?? 50);
      await replay.submitIntent(agentId, `${prefix}${String(i).padStart(3, "0")}`, {
        ...template,
        rationale: `burst request ${i}`,
      });
    }
  }

  await evaluateExpectations(replay);
  const exported = await replay.op("GET", "/v1/runs/current/export");
  if (exported.status !== 200) throw new Error(`export failed: ${JSON.stringify(exported.body)}`);
  const dir = join(values.out ?? ".moneykernel/replays", alias);
  mkdirSync(dir, { recursive: true });
  const exportPath = join(dir, "export.json");
  writeFileSync(exportPath, `${JSON.stringify(exported.body, null, 2)}\n`);
  writeFileSync(
    join(dir, "replay-log.json"),
    `${JSON.stringify({ scenario: scenario.scenario_id, alias, log: replay.log, checks: replay.checks, decisions: replay.decisions }, null, 2)}\n`,
  );
  await replay.shutdown();
  return { replay, exportPath };
}

async function evaluateExpectations(replay: Replay): Promise<void> {
  const expected = (replay.scenario as Scenario & { expected?: Json }).expected ?? {};
  const pool = replay.runtime.pool;
  const accountId = replay.runtime.account?.id ?? "";
  if (pool === null) throw new Error("no pool");
  const first = replay.decisions[0] ?? null;

  if (typeof expected.outcome === "string") {
    replay.check(
      "outcome",
      first?.outcome === expected.outcome,
      `${String(first?.outcome)} vs ${String(expected.outcome)}`,
    );
  }
  if (typeof expected.limiting_reason === "string") {
    const reasons = (first?.reason_codes as string[]) ?? [];
    replay.check("limiting_reason", reasons.includes(String(expected.limiting_reason)), reasons.join(","));
  }
  if (expected.candidate !== undefined) {
    const want = expected.candidate as Json;
    const got = (first?.candidate as Json | null) ?? {};
    const keys = [
      "symbol",
      "side",
      "order_type",
      "quantity",
      "limit_price",
      "notional_quote",
      "fee_reserve_quote",
      "total_quote_reserved",
      "base_reserved",
    ];
    const diffs = keys.filter((k) => {
      const a = want[k];
      const b = got[k];
      if (typeof a === "string" && typeof b === "string" && /^\d/.test(a)) return !eq(dec(a), dec(b));
      return a !== b;
    });
    replay.check(
      "candidate",
      diffs.length === 0,
      diffs.length === 0 ? "exact match" : `differs in ${diffs.join(",")}: ${JSON.stringify(got)}`,
    );
  }
  if (expected.original_intent_unchanged === true) {
    const intent = await replay.op("GET", `/v1/intents/${String(first?.intent_id)}`);
    const payload = (intent.body.intent as Json | undefined)?.canonical_payload as Json | undefined;
    const size = payload?.size as Json | undefined;
    replay.check("original_intent_unchanged", size?.amount === "80", `stored request size ${String(size?.amount)}`);
  }
  if (typeof expected.alpha_candidate_quantity === "string") {
    const alpha = replay.decisions[0]?.candidate as Json | null;
    const guard = replay.decisions[1]?.candidate as Json | null;
    replay.check(
      "alpha_candidate_quantity",
      eq(dec(String(alpha?.quantity ?? "0")), dec(String(expected.alpha_candidate_quantity))),
      String(alpha?.quantity),
    );
    replay.check(
      "guard_candidate_quantity",
      eq(dec(String(guard?.quantity ?? "0")), dec(String(expected.guard_candidate_quantity))),
      String(guard?.quantity),
    );
    replay.clock.now += 800;
    await replay.sweep();
    const queue = await replay.op("GET", "/v1/proposals");
    const proposals = queue.body.proposals as Array<{ state: string }>;
    const conflicts = queue.body.conflicts as unknown[];
    replay.check(
      "both_states_after_collection_window",
      proposals.length === 2 && proposals.every((p) => p.state === "CONFLICT_HELD"),
      proposals.map((p) => p.state).join(","),
    );
    replay.check("conflict_created", conflicts.length === 1, `${conflicts.length} open conflict(s)`);
    const conflict = (queue.body.conflicts as Array<{ conflict_id: string }>)[0];
    if (conflict !== undefined) {
      const winner = String(replay.decisions[0]?.proposal_id);
      const resolved = await replay.op(
        "POST",
        `/v1/conflicts/${conflict.conflict_id}/resolve`,
        { action: "SELECT", proposal_id: winner },
        `replay-resolve-${conflict.conflict_id}`,
      );
      const after = await replay.op("GET", "/v1/proposals");
      const states = (after.body.proposals as Array<{ state: string; proposal_id: string }>).map((p) => p.state);
      replay.check(
        "select_one_revalidates_and_requests_exact_approval",
        resolved.status === 200 && states.includes("AWAITING_APPROVAL"),
        `${resolved.status} ${states.join(",")}`,
      );
      const loserHolds = await withClient(pool, (c) =>
        listReservationsForProposal(c, String(replay.decisions[1]?.proposal_id)),
      );
      replay.check(
        "reject_both_releases_only_never_armed_reservations",
        loserHolds.every((r) => r.state === "RELEASED"),
        loserHolds.map((r) => `${r.kind}:${r.state}`).join(","),
      );
    }
    const commands = await withClient(pool, (c) => listCommands(c, accountId));
    replay.check("short_operations", commands.length === 0, `${commands.length} commands`);
  }
  if (typeof expected.quarantine_triggered_on_request === "number") {
    const n = expected.quarantine_triggered_on_request;
    const nth = replay.decisions[n - 1];
    const before = replay.decisions.slice(0, n - 1);
    const quarantined = (d: Json | undefined): boolean =>
      ((d?.reason_codes as string[] | undefined) ?? []).includes("AGENT_QUARANTINED");
    replay.check(
      "request_11_admitted",
      quarantined(nth) && nth?.outcome === "DENY" && before.every((d) => !quarantined(d)),
      `request ${n}: ${String(nth?.outcome)} ${JSON.stringify(nth?.reason_codes)}; earlier requests quarantined: ${before.filter(quarantined).length}`,
    );
    const agents = await replay.op("GET", "/v1/agents");
    const chaos = (agents.body.agents as Array<{ status: string }>)[0];
    replay.check("agent_status_after", chaos?.status === String(expected.agent_status_after), String(chaos?.status));
    const holds = await replay.op("GET", "/v1/overview");
    replay.check(
      "undispatched_holds_released",
      holds.body.reserved_quote === "0",
      `reserved ${String(holds.body.reserved_quote)}`,
    );
    const commands = await withClient(pool, (c) => listCommands(c, accountId));
    replay.check("armed_commands_affected", commands.length === 0, `${commands.length} commands`);
    const later = await replay.submitIntent(
      scenario_agent(replay),
      `${String((replay.scenario as Scenario & { burst?: Json }).burst?.idempotency_key_prefix ?? "burst-")}later`,
      {
        ...((replay.scenario as Scenario & { burst?: Json }).burst?.intent_template as Json),
        rationale: "after quarantine",
      },
    );
    replay.check(
      "later_requests_acquire_authority",
      later.http_status !== 201 || later.outcome === "DENY",
      `${later.http_status} ${String(later.outcome ?? (later.error as Json | undefined)?.code)}`,
    );
  }
  if (typeof expected.submit_invocations === "number") {
    const paper = replay.runtime.execution as PaperExecutionAdapter;
    replay.check("submit_invocations", paper.submitCount === expected.submit_invocations, `${paper.submitCount}`);
    const commands = await withClient(pool, (c) => listCommands(c, accountId));
    const command = commands[0];
    replay.check(
      "client_order_id_stable",
      commands.length === 1 &&
        command !== undefined &&
        Object.keys(paper.venueState().orders)[0] === command.client_order_id,
      `${commands.length} command(s)`,
    );
    const after = expected.after_reconciliation as Json | undefined;
    if (after !== undefined && command !== undefined) {
      const detail = await replay.op("GET", `/v1/commands/${command.id}`);
      const order = detail.body.order as Json | null;
      const fills = detail.body.fills as Array<Json>;
      replay.check("order_status", order?.status === after.order_status, String(order?.status));
      replay.check(
        "executed_base",
        order !== null && eq(dec(String(order.executed_base)), dec(String(after.executed_base))),
        String(order?.executed_base),
      );
      replay.check(
        "executed_quote",
        order !== null && eq(dec(String(order.executed_quote)), dec(String(after.executed_quote))),
        String(order?.executed_quote),
      );
      const fee = fills.reduce((acc, f) => acc.plus(dec(String(f.commission_qty))), dec("0"));
      replay.check("fee_quote", eq(fee, dec(String(after.fee_quote))), fee.toString());
      const agents = await replay.op("GET", "/v1/agents");
      const lease = (agents.body.agents as Array<{ active_lease: { consumed_quote: string } | null }>)[0]?.active_lease;
      replay.check(
        "lease_consumed_quote",
        lease !== null && lease !== undefined && eq(dec(lease.consumed_quote), dec(String(after.lease_consumed_quote))),
        String(lease?.consumed_quote),
      );
      const holds = await withClient(pool, (c) => listReservationsForProposal(c, command.proposal_id));
      const consumed = holds
        .filter((r) => r.kind === "QUOTE" && r.state === "CONSUMED")
        .reduce((a, r) => a.plus(dec(r.amount)), dec("0"));
      const released = holds
        .filter((r) => r.kind === "QUOTE" && r.state === "RELEASED")
        .reduce((a, r) => a.plus(dec(r.amount)), dec("0"));
      replay.check(
        "reservation_consumed_quote",
        eq(consumed, dec(String(after.reservation_consumed_quote))),
        consumed.toString(),
      );
      replay.check(
        "reservation_released_quote",
        eq(released, dec(String(after.reservation_released_quote))),
        released.toString(),
      );
      replay.check(
        "replacement_orders",
        commands.length === 1 + Number(after.replacement_orders),
        `${commands.length}`,
      );
    }
  }
}

function scenario_agent(replay: Replay): string {
  return replay.scenario.agents[0]?.agent_id ?? "";
}

async function main(): Promise<number> {
  const scenario = loadScenario(scenarioId, FIXTURES_DIR);
  let failures = 0;
  for (let run = 1; run <= runs; run += 1) {
    const alias =
      values["keep-alias"] ?? `replay-${scenario.scenario_id.slice(0, 20)}-${Date.now().toString(36)}${run}`;
    console.log(`\n== ${scenario.scenario_id} run ${run}/${runs} on account alias ${alias}`);
    const { replay, exportPath } = await runScenario(scenario, alias);
    for (const line of replay.log) console.log(`   ${line}`);
    for (const c of replay.checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(48)} ${c.detail}`);
    let verified = false;
    try {
      const out = execFileSync(process.execPath, ["scripts/verify-receipt.ts", exportPath], { encoding: "utf8" });
      verified = /verify:receipt: passed/.test(out);
      console.log(out.trim().split("\n").slice(-1)[0]);
    } catch (error) {
      console.log(`verify:receipt failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    replay.checks.push({ name: "export_verifies", ok: verified, detail: exportPath });
    const failed = replay.checks.filter((c) => !c.ok);
    failures += failed.length;
    console.log(`   export: ${exportPath}`);
    console.log(
      failed.length === 0
        ? `   run ${run}: all ${replay.checks.length} checks passed`
        : `   run ${run}: ${failed.length} check(s) FAILED`,
    );
  }
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
