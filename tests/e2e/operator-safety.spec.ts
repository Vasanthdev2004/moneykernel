import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { DecisionResponse } from "@moneykernel/contracts";
import { dec, toDecimalString } from "@moneykernel/domain";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { IntentDocument, LedgerResponse, PolicyResponse } from "../../apps/web/src/types.ts";

const API = `http://127.0.0.1:${process.env.E2E_KERNEL_PORT ?? "8080"}`;
const SECRET = process.env.OPERATOR_BOOTSTRAP_SECRET ?? "";
type TestAgent = { id: string; name: string; token: string; leaseId: string; side: "BUY" | "SELL" };

// Share the baseline cache used by console.spec.ts, including when this file is run alone.
// All authority used below belongs to new agents; the baseline agent's token is never used.
test.beforeAll(() => {
  test.skip(SECRET.length === 0, "OPERATOR_BOOTSTRAP_SECRET missing");
  const alias = process.env.E2E_ACCOUNT_ALIAS ?? "";
  const cache = `.moneykernel/e2e/seed-${alias}.json`;
  if (existsSync(cache)) return;
  const output = execFileSync(process.execPath, ["--env-file-if-exists=.env", "scripts/seed-demo.ts"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONEYKERNEL_MODE: "REPLAY",
      MONEYKERNEL_ACCOUNT_ALIAS: alias,
      MONEYKERNEL_STATE_DIR: ".moneykernel/e2e",
    },
  });
  const seed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  mkdirSync(".moneykernel/e2e", { recursive: true });
  writeFileSync(cache, JSON.stringify(seed));
});

async function operator(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API}/v1/auth/session`, { data: { bootstrap_secret: SECRET } });
  expect(response.status()).toBe(201);
  return (await response.json()).session_token as string;
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("login-secret").fill(SECRET);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-status")).toContainText("READY");
}

async function get<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const response = await request.get(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<T>;
}

async function post(request: APIRequestContext, token: string, path: string, data: unknown, status = 201) {
  const response = await request.post(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    data,
  });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function createAgent(request: APIRequestContext, token: string, side: "BUY" | "SELL"): Promise<TestAgent> {
  const name = `Browser ${side} ${randomUUID().slice(0, 8)}`;
  const registered = await post(request, token, "/v1/agents", { name, strategy_kind: "SCRIPTED" });
  const lease = await post(request, token, "/v1/leases", {
    agent_id: registered.agent.id,
    acquisition_budget_quote: side === "BUY" ? "50" : "0",
    max_submission_attempts: 3,
    expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    allowed_symbols: ["BTCUSDT"],
    allowed_sides: [side],
    allowed_order_types: ["LIMIT_IOC"],
  });
  return { id: registered.agent.id, name, token: registered.token, leaseId: lease.lease_id, side };
}

async function policy(request: APIRequestContext, token: string, value: PolicyResponse["policy"]): Promise<void> {
  const current = await get<PolicyResponse>(request, token, "/v1/policy");
  const response = await request.put(`${API}/v1/policy`, {
    headers: { authorization: `Bearer ${token}`, "if-match": String(current.version) },
    data: value,
  });
  expect(response.status(), await response.text()).toBe(201);
}

async function assignInventory(request: APIRequestContext, token: string, seller: TestAgent): Promise<string> {
  await post(request, token, "/v1/account/stop", {}, 200);
  const ledger = await get<LedgerResponse>(request, token, "/v1/ledger");
  const available = ledger.allocations.find(
    (row) => row.agent_or_unassigned_id === "UNASSIGNED" && row.asset === "BTC",
  );
  if (!available) throw new Error("the REPLAY baseline needs unassigned BTC");
  await post(request, token, "/v1/inventory/assignments", {
    assignments: [
      {
        owner: "UNASSIGNED",
        asset: "BTC",
        quantity: toDecimalString(dec(available.owned_quantity).minus(dec("0.0002"))),
      },
      { owner: seller.id, asset: "BTC", quantity: "0.0002" },
    ],
  });
  await post(request, token, "/v1/account/resume", {}, 200);
  return available.owned_quantity;
}

async function restoreInventory(
  request: APIRequestContext,
  token: string,
  seller: TestAgent,
  original: string,
): Promise<void> {
  await post(request, token, "/v1/account/stop", {}, 200);
  await post(request, token, "/v1/inventory/assignments", {
    assignments: [
      { owner: "UNASSIGNED", asset: "BTC", quantity: original },
      { owner: seller.id, asset: "BTC", quantity: "0" },
    ],
  });
  const { incidents } = await get<{ incidents: Array<{ id: string; status: string; severity: string }> }>(
    request,
    token,
    "/v1/incidents",
  );
  await post(
    request,
    token,
    "/v1/account/resume",
    {
      acknowledged_incident_ids: incidents
        .filter((incident) => incident.status === "OPEN" && incident.severity === "CRITICAL")
        .map((incident) => incident.id),
    },
    200,
  );
}

async function propose(request: APIRequestContext, agent: TestAgent): Promise<DecisionResponse> {
  const context = await get<{ observations: Array<{ symbol: string; snapshot_id: string }> }>(
    request,
    agent.token,
    "/v1/agent/context",
  );
  const observation = context.observations.find((row) => row.symbol === "BTCUSDT");
  if (!observation) throw new Error("BTC fixture observation missing");
  return post(request, agent.token, "/v1/agent/intents", {
    schema_version: "1",
    lease_id: agent.leaseId,
    symbol: "BTCUSDT",
    side: agent.side,
    order_type: "LIMIT_IOC",
    limit_price: agent.side === "BUY" ? "100000" : "99999.99",
    size:
      agent.side === "BUY"
        ? { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "20" }
        : { kind: "BASE_QUANTITY", base_asset: "BTC", amount: "0.0001" },
    observation_ids: [observation.snapshot_id],
  });
}

async function heldPair(page: Page, request: APIRequestContext, buyer: TestAgent, seller: TestAgent) {
  const buy = await propose(request, buyer);
  const sell = await propose(request, seller);
  expect(buy.proposal_id).not.toBeNull();
  expect(sell.proposal_id).not.toBeNull();
  for (const decision of [buy, sell]) {
    await expect(
      page.locator(`[data-testid="proposal-row"][data-proposal-id="${decision.proposal_id}"]`),
    ).toHaveAttribute("data-state", "CONFLICT_HELD");
  }
  const conflict = page.locator("#conflicts .conflict").filter({ hasText: buyer.name });
  await expect(conflict).toContainText(seller.name);
  return { buy, sell, conflict };
}

async function expectReleased(request: APIRequestContext, token: string, intentId: string): Promise<void> {
  const document = await get<IntentDocument>(request, token, `/v1/intents/${intentId}`);
  expect(document.command).toBeNull();
  expect(document.proposals.every((proposal) => proposal.reservations.every((hold) => hold.state === "RELEASED"))).toBe(
    true,
  );
}

test("opposing owned-inventory intents require review; selecting needs a separate approval and rejecting releases both", async ({
  page,
  request,
}) => {
  const token = await operator(request);
  const beforePolicy = await get<PolicyResponse>(request, token, "/v1/policy");
  const buyer = await createAgent(request, token, "BUY");
  const seller = await createAgent(request, token, "SELL");
  const original = await assignInventory(request, token, seller);
  try {
    await policy(request, token, { ...beforePolicy.policy, max_symbol_share: "1" });
    await login(page);
    const selected = await heldPair(page, request, buyer, seller);
    await page.locator(`[data-testid="proposal-row"][data-proposal-id="${selected.buy.proposal_id}"]`).click();
    await expect(page.getByTestId("approve-button")).toBeDisabled();
    await selected.conflict
      .locator(".conflict-side")
      .filter({ hasText: buyer.name })
      .getByTestId("conflict-select")
      .click();

    const winner = page.getByTestId("proposal-row").filter({ hasText: buyer.name });
    await expect(winner).toHaveAttribute("data-state", "AWAITING_APPROVAL");
    await winner.click();
    await expect(page.getByTestId("approve-confirm")).not.toBeChecked();
    await expect(page.getByTestId("approve-button")).toBeDisabled();
    const renewed = await get<IntentDocument>(request, token, `/v1/intents/${selected.buy.intent_id}`);
    expect(renewed.proposals.at(-1)?.revision).toBe(2);
    expect(renewed.command).toBeNull();
    await expectReleased(request, token, selected.sell.intent_id);

    // Reject the selected revision through the drawer; selecting alone never created a command.
    await page.getByTestId("reject-button").click();
    await expect(winner).toHaveCount(0);
    await expectReleased(request, token, selected.buy.intent_id);

    const rejected = await heldPair(page, request, buyer, seller);
    await rejected.conflict.getByTestId("conflict-reject-both").click();
    await page.getByTestId("reject-both-dialog").getByRole("button", { name: "Reject both", exact: true }).click();
    await expect(rejected.conflict).toHaveCount(0);
    await expectReleased(request, token, rejected.buy.intent_id);
    await expectReleased(request, token, rejected.sell.intent_id);
  } finally {
    await restoreInventory(request, token, seller, original);
    await policy(request, token, beforePolicy.policy);
  }
});

test("operator quarantine invalidates pending authority and refuses the same agent's later requests", async ({
  page,
  request,
}) => {
  const token = await operator(request);
  const agent = await createAgent(request, token, "SELL");
  const original = await assignInventory(request, token, agent);
  try {
    await login(page);
    const pending = await propose(request, agent);
    expect(pending.proposal_id).not.toBeNull();
    const proposalRow = page.locator(`[data-testid="proposal-row"][data-proposal-id="${pending.proposal_id}"]`);
    await expect(proposalRow).toHaveAttribute("data-state", "AWAITING_APPROVAL");
    const row = page.getByTestId("agent-row").filter({ hasText: agent.name });
    await row.getByRole("button", { name: "Quarantine", exact: true }).click();
    await page.getByTestId("quarantine-dialog").getByRole("button", { name: "Quarantine agent", exact: true }).click();
    await expect(row).toContainText("QUARANTINED");
    await expect(proposalRow).toHaveCount(0);
    await expect(row).toContainText("0.0002 BTC");
    await expectReleased(request, token, pending.intent_id);

    const denied = await propose(request, agent);
    expect(denied.outcome).toBe("DENY");
    expect(denied.reason_codes).toContain("AGENT_QUARANTINED");
    expect(denied.proposal_id).toBeNull();
    expect(denied.candidate).toBeNull();
  } finally {
    await restoreInventory(request, token, agent, original);
  }
});
