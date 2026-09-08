import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { type RunExport, RunExportSchema } from "@moneykernel/contracts";
import { dec, toDecimalString } from "@moneykernel/domain";
import { PaperVenueStateSchema } from "@moneykernel/integrations";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { formatReport, verifyRunExport } from "../../scripts/verify-receipt.ts";
import { stopOwnedChild, waitForOwnedChild } from "./owned-process.ts";

/**
 * Demo rehearsal (prd.md 21.2 G7, 23.1, 23.2, 26): the four scenes of the recorded demo, each on a fresh REPLAY
 * account and its own kernel process, agents acting through the agent API and the operator acting only through
 * the console. Screenshots land under docs/evidence/demo/<run>/ so the submission package matches the backend
 * events of a real rehearsal. `pnpm demo:rehearse` runs this three times in a row.
 */
const KERNEL_PORT = Number(process.env.E2E_KERNEL_PORT ?? 8080);
const KERNEL = `http://127.0.0.1:${KERNEL_PORT}`;
const SECRET = process.env.OPERATOR_BOOTSTRAP_SECRET ?? "";
const STATE_DIR = ".moneykernel/demo";
const runStamp =
  process.env.REHEARSAL_STAMP ??
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
let repeat = 0;

type Seed = { agents: Array<{ fixture_agent_id: string; token: string; lease_id: string }> };
type Kernel = { child: ChildProcess; alias: string };

function shotDir(): string {
  const dir = join("docs", "evidence", "demo", `${runStamp}-run${repeat}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitForKernel(child: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("owned kernel exited before readiness");
    }
    try {
      const res = await fetch(`${KERNEL}/health/live`, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("kernel did not come up");
}

async function startKernel(alias: string, fixture: string): Promise<Kernel> {
  // Fail before spawning if another checkout owns this port; never reuse or stop it.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(KERNEL_PORT, "127.0.0.1", () => probe.close((error) => (error ? reject(error) : resolve())));
  });
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "apps/kernel/src/server.ts"], {
    env: {
      ...process.env,
      MONEYKERNEL_MODE: "REPLAY",
      MONEYKERNEL_ACCOUNT_ALIAS: alias,
      MONEYKERNEL_STATE_DIR: STATE_DIR,
      REPLAY_FIXTURE: fixture,
      PORT: String(KERNEL_PORT),
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  await waitForOwnedChild(child, async () => {
    await waitForKernel(child);
    const ready = (await (await fetch(`${KERNEL}/health/ready`, { signal: AbortSignal.timeout(2000) })).json()) as {
      checks: Array<{ name: string; detail: string }>;
    };
    const configuration = ready.checks.find((c) => c.name === "configuration")?.detail ?? "";
    if (!configuration.split(/\s+/).includes(`alias=${alias}`))
      throw new Error("live kernel account differs from this scene");
  });
  return { child, alias };
}

/** Crash the kernel the way an operator's Ctrl+C or a process crash would: the venue journal on disk survives. */
async function stopKernel(kernel: Kernel): Promise<void> {
  await stopOwnedChild(kernel.child);
}

function seed(alias: string, fixture: string): Seed {
  const out = execFileSync(process.execPath, ["--env-file-if-exists=.env", "scripts/seed-demo.ts", fixture], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      MONEYKERNEL_MODE: "REPLAY",
      MONEYKERNEL_ACCOUNT_ALIAS: alias,
      MONEYKERNEL_STATE_DIR: STATE_DIR,
    },
  });
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Seed;
}

function agentOf(seedResult: Seed, fixtureId: string) {
  const agent = seedResult.agents.find((a) => a.fixture_agent_id === fixtureId);
  if (agent === undefined) throw new Error(`${fixtureId} not seeded`);
  return agent;
}

async function observation(request: APIRequestContext, token: string, symbol: string): Promise<string> {
  const res = await request.get(`${KERNEL}/v1/agent/context`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBeTruthy();
  const ctx = (await res.json()) as { observations: Array<{ snapshot_id: string; symbol: string }> };
  const obs = ctx.observations.find((o) => o.symbol === symbol);
  if (obs === undefined) throw new Error(`no observation for ${symbol}`);
  return obs.snapshot_id;
}

type Decision = {
  intent_id: string;
  proposal_id: string | null;
  outcome: string;
  state: string;
  candidate: { quantity: string } | null;
  reason_codes: string[];
};

async function submit(
  request: APIRequestContext,
  agent: { token: string; lease_id: string },
  key: string,
  intent: Record<string, unknown>,
): Promise<Decision> {
  const res = await request.post(`${KERNEL}/v1/agent/intents`, {
    headers: { authorization: `Bearer ${agent.token}`, "idempotency-key": key },
    data: { schema_version: "1", lease_id: agent.lease_id, ...intent },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as Decision;
}

async function operatorSession(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${KERNEL}/v1/auth/session`, { data: { bootstrap_secret: SECRET } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { session_token: string }).session_token;
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("login-secret").fill(SECRET);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-status")).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(shotDir(), `${name}.png`), fullPage: true });
}

async function exportScene(page: Page, scene: string, alias: string): Promise<RunExport> {
  const pending = page.waitForEvent("download");
  await page.getByTestId("export-run").click();
  const download = await pending;
  const path = await download.path();
  if (path === null) throw new Error("scene export was not downloaded");
  const bundle = RunExportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  expect(bundle.account.alias).toBe(alias);
  expect(bundle.environment).toBe("REPLAY");
  const report = verifyRunExport(bundle);
  writeFileSync(join(shotDir(), `${scene}.verification.json`), JSON.stringify(report, null, 2));
  // Do not copy a failed privacy scan into publishable evidence.
  expect(report.checks.find((check) => check.name === "secret_scan")?.ok).toBe(true);
  await download.saveAs(join(shotDir(), `${scene}.export.json`));
  expect(report.ok, formatReport(report)).toBe(true);
  return bundle;
}

const amount = (value: unknown): string => toDecimalString(dec(String(value)));
const sum = (rows: Array<Record<string, unknown>>, field: string): string =>
  toDecimalString(rows.reduce((total, row) => total.plus(dec(String(row[field]))), dec("0")));

function venue(alias: string) {
  return PaperVenueStateSchema.parse(
    JSON.parse(readFileSync(join(STATE_DIR, `paper-venue-REPLAY-${alias}.json`), "utf8")),
  );
}

test.beforeEach(async ({ browserName }, testInfo) => {
  void browserName; // Playwright requires the destructuring form; Biome forbids an empty pattern
  repeat = testInfo.repeatEachIndex + 1;
});

test("scene A: constrained acquisition is counterproposed, exactly approved, settled as a paper fill", async ({
  page,
  request,
}) => {
  const alias = `demo-a-${runStamp.toLowerCase()}-${repeat}`;
  const kernel = await startKernel(alias, "scenario-a-constrained-acquisition");
  try {
    const seeded = seed(alias, "scenario-a-constrained-acquisition");
    const alpha = agentOf(seeded, "agent_alpha");
    await login(page);
    await expect(page.getByTestId("account-status")).toContainText("READY");
    await shot(page, "a1-ready-mode-and-integration");

    const decision = await submit(request, alpha, `demo-a-${repeat}`, {
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
      limit_price: "100",
      observation_ids: [await observation(request, alpha.token, "SOLUSDT")],
    });
    expect(decision.outcome).toBe("COUNTERPROPOSE");
    expect(decision.candidate?.quantity).toBe("0.27");
    expect(decision.reason_codes).toContain("SYMBOL_EXPOSURE_LIMIT");
    const row = page.getByTestId("proposal-row").first();
    await expect(row).toHaveAttribute("data-state", "AWAITING_APPROVAL");
    await row.click();
    await expect(page.getByTestId("approve-button")).toBeDisabled();
    await shot(page, "a2-counterproposal-drawer");
    await page.getByTestId("approve-confirm").check();
    await page.getByTestId("approve-button").click();
    const command = page.getByTestId("command-row").first();
    await expect(command).toHaveAttribute("data-state", "ACCEPTED");
    await expect(page.locator('[data-testid="timeline-event"][data-event-type="FILL_RECONCILED"]')).toHaveCount(1);
    await expect(page.getByTestId("unresolved")).toHaveText("0");
    await shot(page, "a3-settled-fill-and-receipt");
    const bundle = await exportScene(page, "a", alias);
    expect(bundle.commands).toHaveLength(1);
    expect(sum(bundle.fills, "base_qty")).toBe("0.27");
  } finally {
    await stopKernel(kernel);
  }
});

test("scene B: opposing owned-inventory intents are held and resolved by the operator", async ({ page, request }) => {
  const alias = `demo-b-${runStamp.toLowerCase()}-${repeat}`;
  const kernel = await startKernel(alias, "scenario-b-opposing-intents");
  try {
    const seeded = seed(alias, "scenario-b-opposing-intents");
    const alpha = agentOf(seeded, "agent_alpha");
    const guard = agentOf(seeded, "agent_inventory_guard");
    await login(page);
    const buy = await submit(request, alpha, `demo-b-buy-${repeat}`, {
      symbol: "BTCUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "50" },
      limit_price: "100000",
      observation_ids: [await observation(request, alpha.token, "BTCUSDT")],
    });
    const sell = await submit(request, guard, `demo-b-sell-${repeat}`, {
      symbol: "BTCUSDT",
      side: "SELL",
      order_type: "LIMIT_IOC",
      size: { kind: "BASE_QUANTITY", base_asset: "BTC", amount: "0.0002" },
      limit_price: "100000",
      observation_ids: [await observation(request, guard.token, "BTCUSDT")],
    });
    expect(buy.candidate?.quantity).toBe("0.0005");
    expect(sell.candidate?.quantity).toBe("0.0002");
    await expect(page.getByTestId("conflict-select").first()).toBeVisible();
    await expect(page.locator('[data-testid="proposal-row"][data-state="CONFLICT_HELD"]')).toHaveCount(2);
    await shot(page, "b1-opposing-intents-held");
    // The member card wrapping the button carries the candidate line ("BUY 0.0005 BTC @ 100000 = 50 USDT").
    const winner = page.locator(".conflict-side", { hasText: "BUY" }).getByTestId("conflict-select");
    await expect(winner).toHaveCount(1);
    await winner.click();
    await expect(page.locator('[data-testid="proposal-row"][data-state="AWAITING_APPROVAL"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="proposal-row"][data-state="CONFLICT_HELD"]')).toHaveCount(0);
    await expect(page.getByTestId("command-row")).toHaveCount(0);
    await shot(page, "b2-winner-revalidated-loser-released");
    const bundle = await exportScene(page, "b", alias);
    expect(bundle.commands).toHaveLength(0);
    expect(bundle.approvals).toHaveLength(0);
    const loserHolds = bundle.reservations.filter((hold) => hold.proposal_id === sell.proposal_id);
    expect(loserHolds.length).toBeGreaterThan(0);
    expect(loserHolds.every((hold) => hold.state === "RELEASED")).toBe(true);
    expect(
      bundle.proposals.some(
        (proposal) =>
          proposal.intent_id === buy.intent_id && proposal.revision === 2 && proposal.state === "AWAITING_APPROVAL",
      ),
    ).toBe(true);
  } finally {
    await stopKernel(kernel);
  }
});

test("scene C: a scripted burst is quarantined durably on the eleventh request", async ({ page, request }) => {
  const alias = `demo-c-${runStamp.toLowerCase()}-${repeat}`;
  const kernel = await startKernel(alias, "scenario-c-burst-quarantine");
  try {
    const seeded = seed(alias, "scenario-c-burst-quarantine");
    const chaos = agentOf(seeded, "agent_chaos");
    await login(page);
    const decisions: Decision[] = [];
    for (let i = 1; i <= 11; i += 1) {
      decisions.push(
        await submit(request, chaos, `demo-c-${repeat}-${String(i).padStart(3, "0")}`, {
          symbol: "SOLUSDT",
          side: "BUY",
          order_type: "LIMIT_IOC",
          size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "7" },
          limit_price: "100",
          observation_ids: [await observation(request, chaos.token, "SOLUSDT")],
          rationale: `burst request ${i}`,
        }),
      );
    }
    expect(decisions.slice(0, 10).every((d) => !d.reason_codes.includes("AGENT_QUARANTINED"))).toBe(true);
    expect(decisions[10]?.outcome).toBe("DENY");
    expect(decisions[10]?.reason_codes).toContain("AGENT_QUARANTINED");
    const agentRow = page.getByTestId("agent-row").first();
    await expect(agentRow).toContainText("QUARANTINED");
    await expect(page.getByTestId("reserved-quote")).toHaveText("0 USDT");
    await expect(page.locator('[data-testid="timeline-event"][data-event-type="AGENT_QUARANTINED"]')).toHaveCount(1);
    await shot(page, "c1-burst-quarantined");
    const later = await submit(request, chaos, `demo-c-${repeat}-later`, {
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "7" },
      limit_price: "100",
      observation_ids: [await observation(request, chaos.token, "SOLUSDT")],
      rationale: "after quarantine",
    });
    expect(later.outcome).toBe("DENY");
    expect(later.reason_codes).toContain("AGENT_QUARANTINED");
    const bundle = await exportScene(page, "c", alias);
    expect(bundle.commands).toHaveLength(0);
    expect(bundle.approvals).toHaveLength(0);
    expect(bundle.reservations.every((hold) => hold.state === "RELEASED")).toBe(true);
  } finally {
    await stopKernel(kernel);
  }
});

test("scene D: a dropped response survives a crash and reconciles from the venue, one submission", async ({
  page,
  request,
}) => {
  const alias = `demo-d-${runStamp.toLowerCase()}-${repeat}`;
  let kernel = await startKernel(alias, "scenario-d-lost-response");
  try {
    const seeded = seed(alias, "scenario-d-lost-response");
    const alpha = agentOf(seeded, "agent_alpha");
    await login(page);
    const decision = await submit(request, alpha, `demo-d-${repeat}`, {
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "20" },
      limit_price: "100",
      observation_ids: [await observation(request, alpha.token, "SOLUSDT")],
    });
    expect(decision.proposal_id).not.toBeNull();
    // SYNTHETIC FAULT SCENARIO: accept and drop the response, then hold queries unavailable until restart.
    // This makes the recorded uncertainty interval explicit despite background reconciliation (prd.md 27.4).
    const operatorToken = await operatorSession(request);
    const fault = await request.post(`${KERNEL}/v1/demo/faults`, {
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": `demo-d-fault-${repeat}` },
      data: { kind: "DROP_RESPONSE_AFTER_ACCEPT", proposal_id: decision.proposal_id, hold_queries_until_restart: true },
    });
    expect(fault.status()).toBe(201);
    expect((await fault.json()).hold_queries_until_restart).toBe(true);
    const row = page.getByTestId("proposal-row").first();
    await expect(row).toHaveAttribute("data-state", "AWAITING_APPROVAL");
    await row.click();
    await page.getByTestId("approve-confirm").check();
    await page.getByTestId("approve-button").click();
    const command = page.getByTestId("command-row").first();
    await expect(command).toHaveAttribute("data-state", "OUTCOME_UNKNOWN");
    await expect(page.getByTestId("unknown-banner")).toBeVisible();
    await shot(page, "d1-outcome-unknown-banner");
    const beforeResponse = await request.get(`${KERNEL}/v1/commands`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(beforeResponse.ok()).toBe(true);
    const before = (await beforeResponse.json()).commands as Array<{
      id: string;
      client_order_id: string;
      state: string;
    }>;
    expect(before).toHaveLength(1);
    const original = before[0];
    if (original === undefined) throw new Error("unknown command missing");
    expect(original.state).toBe("OUTCOME_UNKNOWN");
    const beforeVenue = venue(alias);
    expect(beforeVenue.submissions).toBe(1);
    expect(Object.keys(beforeVenue.orders)).toEqual([original.client_order_id]);
    writeFileSync(join(shotDir(), "d.before-restart.venue.json"), JSON.stringify(beforeVenue, null, 2));

    // The kernel has persisted uncertainty; the venue has accepted the order. Restart must query that same order.
    await stopKernel(kernel);
    kernel = await startKernel(alias, "scenario-d-lost-response");
    await login(page);
    await expect(command).toHaveAttribute("data-state", "ACCEPTED");
    await expect(page.getByTestId("unknown-banner")).toHaveCount(0);
    await expect(page.getByTestId("account-status")).toContainText("PAUSED");
    await expect(page.getByTestId("unresolved")).toHaveText("0");
    await shot(page, "d2-recovered-after-restart");
    const operatorToken2 = await operatorSession(request);
    const detail = await request.get(`${KERNEL}/v1/commands`, {
      headers: { authorization: `Bearer ${operatorToken2}` },
    });
    const commands = (
      (await detail.json()) as { commands: Array<{ id: string; state: string; client_order_id: string }> }
    ).commands;
    expect(commands.length).toBe(1);
    expect(commands[0]?.state).toBe("ACCEPTED");
    expect(commands[0]?.id).toBe(original.id);
    expect(commands[0]?.client_order_id).toBe(original.client_order_id);
    const one = await request.get(`${KERNEL}/v1/commands/${commands[0]?.id ?? ""}`, {
      headers: { authorization: `Bearer ${operatorToken2}` },
    });
    const body = (await one.json()) as { order: { status: string; executed_base: string }; fills: unknown[] };
    expect(body.order.status).toBe("EXPIRED");
    expect(amount(body.order.executed_base)).toBe("0.12");
    expect(body.fills.length).toBe(1);
    await page.getByTestId("resume-button").click();
    const resumeConfirm = page.getByTestId("resume-confirm");
    await expect(resumeConfirm).toBeVisible();
    await expect(resumeConfirm).toBeEnabled();
    await resumeConfirm.click();
    await expect(page.getByTestId("account-status")).toContainText("READY");
    await shot(page, "d3-resumed-after-reconciliation");
    const bundle = await exportScene(page, "d", alias);
    expect(bundle.commands).toHaveLength(1);
    expect(bundle.commands[0]?.id).toBe(original.id);
    expect(bundle.commands[0]?.client_order_id).toBe(original.client_order_id);
    expect(bundle.orders).toHaveLength(1);
    expect(amount(bundle.orders[0]?.executed_base)).toBe("0.12");
    expect(amount(bundle.orders[0]?.executed_quote)).toBe("12");
    expect(sum(bundle.fills, "commission_qty")).toBe("0.012");
    expect(bundle.fills.every((fill) => fill.commission_asset === "USDT")).toBe(true);
    expect(amount(bundle.leases[0]?.consumed_quote)).toBe("12.012");
    const quoteHolds = bundle.reservations.filter((hold) => hold.kind === "QUOTE");
    expect(
      sum(
        quoteHolds.filter((hold) => hold.state === "CONSUMED"),
        "amount",
      ),
    ).toBe("12.012");
    expect(
      sum(
        quoteHolds.filter((hold) => hold.state === "RELEASED"),
        "amount",
      ),
    ).toBe("8.008");
    expect(bundle.reservations.some((hold) => hold.state === "HELD" || hold.state === "ARMED")).toBe(false);
    expect(amount(bundle.balances.find((balance) => balance.asset === "USDT")?.owned_quantity)).toBe("987.988");
    expect(amount(bundle.balances.find((balance) => balance.asset === "SOL")?.owned_quantity)).toBe("0.12");
    const afterVenue = venue(alias);
    expect(afterVenue.submissions).toBe(1);
    expect(Object.keys(afterVenue.orders)).toEqual([original.client_order_id]);
    expect(afterVenue.orders[original.client_order_id]).toEqual(beforeVenue.orders[original.client_order_id]);
    writeFileSync(join(shotDir(), "d.after-restart.venue.json"), JSON.stringify(afterVenue, null, 2));
  } finally {
    await stopKernel(kernel);
  }
});
