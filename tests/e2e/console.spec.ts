import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { verifyRunExport } from "../../scripts/verify-receipt.ts";

/**
 * Operator flows through the real console and kernel (prd.md 17, 20.1 e2e):
 * login, exact approval of a counterproposed candidate, settlement visible as
 * ACCEPTED (not FILLED) plus reconciled fill events, receipt export, stop and
 * readiness-gated resume, and event-stream catch-up after a reload (T-53).
 */
type Seed = { agents: Array<{ fixture_agent_id: string; token: string; lease_id: string }> };

const SECRET = process.env.OPERATOR_BOOTSTRAP_SECRET ?? "";
const API = `http://127.0.0.1:${process.env.E2E_KERNEL_PORT ?? "8080"}`;
let seed: Seed;

// Seeding is once per account alias; a worker restart after a failed test reuses the recorded tokens.
test.beforeAll(() => {
  const alias = process.env.E2E_ACCOUNT_ALIAS ?? "";
  const cache = `.moneykernel/e2e/seed-${alias}.json`;
  if (existsSync(cache)) {
    seed = JSON.parse(readFileSync(cache, "utf8")) as Seed;
    return;
  }
  const out = execFileSync(process.execPath, ["--env-file-if-exists=.env", "scripts/seed-demo.ts"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONEYKERNEL_MODE: "REPLAY",
      MONEYKERNEL_ACCOUNT_ALIAS: alias,
      MONEYKERNEL_STATE_DIR: ".moneykernel/e2e",
    },
  });
  seed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Seed;
  mkdirSync(".moneykernel/e2e", { recursive: true });
  writeFileSync(cache, JSON.stringify(seed));
});

const eventRows = (page: Page, type: string) =>
  page.locator(`[data-testid="timeline-event"][data-event-type="${type}"]`);

const sections = ["overview", "approvals", "agents", "activity", "system"] as const;
async function navigate(page: Page, section: (typeof sections)[number]): Promise<void> {
  const tab = page.getByTestId(`nav-${section}`);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page");
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("login-secret").fill(SECRET);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-status")).toBeVisible();
}

async function logout(page: Page): Promise<void> {
  await page.getByTestId("workspace-menu").click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
}

test("approve an exact candidate, watch it settle, export the receipt, reload without duplicates", async ({
  page,
  request,
}) => {
  test.skip(SECRET.length === 0, "OPERATOR_BOOTSTRAP_SECRET missing");
  await login(page);
  await expect(page.getByTestId("account-status")).toContainText("READY");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByTestId("account-status")).toContainText("READY");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const section of sections) {
    await navigate(page, section);
    await expect(page.getByTestId("stop-button")).toBeInViewport();
  }
  await navigate(page, "overview");
  await expect(page.getByTestId("stop-button")).toBeVisible();
  await expect(page.getByTestId("available-quote")).toHaveText("100 USDT");
  await expect(page.getByTestId("cash-buffer-quote")).toHaveText("10 USDT");

  // The agent proposes through its own API; the console never holds agent tokens.
  const alpha = seed.agents.find((a) => a.fixture_agent_id === "agent_alpha");
  if (alpha === undefined) throw new Error("alpha not seeded");
  const context = await request.get(`${API}/v1/agent/context`, {
    headers: { authorization: `Bearer ${alpha.token}` },
  });
  expect(context.ok()).toBeTruthy();
  const ctx = (await context.json()) as { observations: Array<{ snapshot_id: string; symbol: string }> };
  const obs = ctx.observations.find((o) => o.symbol === "SOLUSDT");
  if (obs === undefined) throw new Error("no SOL observation");
  const submitted = await request.post(`${API}/v1/agent/intents`, {
    headers: { authorization: `Bearer ${alpha.token}`, "idempotency-key": `e2e-${Date.now()}` },
    data: {
      schema_version: "1",
      lease_id: alpha.lease_id,
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
      limit_price: "100",
      observation_ids: [obs.snapshot_id],
    },
  });
  expect(submitted.status()).toBe(201);
  const decision = (await submitted.json()) as {
    proposal_id: string;
    outcome: string;
    candidate: { quantity: string };
  };
  expect(decision.outcome).toBe("COUNTERPROPOSE");
  expect(decision.candidate.quantity).toBe("0.27");

  // Counterproposed is not approved: the queue shows the exact candidate awaiting a human.
  await navigate(page, "approvals");
  const row = page
    .getByTestId("proposal-row")
    .filter({ hasText: decision.proposal_id.slice(0, 12) })
    .first();
  await expect(row).toHaveAttribute("data-state", "AWAITING_APPROVAL");
  await expect(row).toContainText("0.27");
  await row.click();
  await expect(page.getByTestId("approve-button")).toBeDisabled();
  await page.getByTestId("approve-confirm").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("approve-confirm")).toBeChecked();
  await page.getByTestId("approve-button").focus();
  await page.keyboard.press("Enter");

  // Approved is not submitted; accepted is not filled. The command settles and the fill events land on the timeline.
  await navigate(page, "activity");
  const command = page.getByTestId("command-row").first();
  await expect(command).toHaveAttribute("data-state", "ACCEPTED");
  await expect(command).toContainText("ACCEPTED");
  await expect(command).not.toContainText("NOT FILLED");
  await expect(eventRows(page, "FILL_RECONCILED")).toHaveCount(1);
  await navigate(page, "overview");
  await expect(page.getByTestId("unresolved")).toContainText("0");

  await navigate(page, "activity");
  await eventRows(page, "DECISION_RECORDED").first().getByRole("button", { name: "open receipt", exact: true }).click();
  // Rule names and financial values remain readable in the selected receipt.
  const rule = page.locator(".checks tbody tr").first().locator("td").nth(1).locator(".mono");
  const ruleLines = await rule.evaluate(
    (element) =>
      element.getBoundingClientRect().height /
      Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).lineHeight ?? "0"),
  );
  expect(ruleLines).toBeLessThanOrEqual(1.2);

  // Evidence for the submission package: the real console after a settled fill (prd.md 23.4).
  await page.screenshot({ path: "docs/evidence/console-after-settlement.png", fullPage: true });

  const download = page.waitForEvent("download");
  await page.getByTestId("export-receipt").click();
  expect((await download).suggestedFilename()).toMatch(/^receipt-.*\.json$/);

  const runDownload = page.waitForEvent("download");
  await page.getByTestId("workspace-menu").click();
  await page.getByTestId("export-run").click();
  const exported = await runDownload;
  expect(exported.suggestedFilename()).toMatch(/^moneykernel-run-.*\.json$/);
  const exportPath = await exported.path();
  if (exportPath === null) throw new Error("run export was not downloaded");
  const exportText = readFileSync(exportPath, "utf8");
  const report = verifyRunExport(JSON.parse(exportText));
  expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.summary).toMatchObject({ receipts: 1, replayed: 1, commands: 1, fills: 1 });
  expect(exportText).not.toContain(SECRET);
  expect(exportText).not.toContain(alpha.token);

  // T-53: a reload catches up from the durable log without duplicating committed events.
  await page.reload();
  await expect(page.getByTestId("account-status")).toBeVisible();
  await navigate(page, "activity");
  await expect(eventRows(page, "FILL_RECONCILED")).toHaveCount(1);
  await expect(eventRows(page, "COMMAND_ARMED")).toHaveCount(1);
});

test("Overview keeps administration separate and navigation preserves mode and Stop at tablet and phone widths", async ({
  page,
}) => {
  test.skip(SECRET.length === 0, "OPERATOR_BOOTSTRAP_SECRET missing");
  await login(page);
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#agent-name")).toHaveCount(0);
  await expect(page.locator("#lease-budget")).toHaveCount(0);
  await expect(page.locator("#policy")).toHaveCount(0);
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const section of sections) {
      await navigate(page, section);
      const size = await page.locator("html").evaluate((element) => ({
        content: element.scrollWidth,
        viewport: element.clientWidth,
      }));
      expect(size.content).toBeLessThanOrEqual(size.viewport);
      await page.locator(".footer").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("stop-button")).toBeInViewport();
      await expect(page.locator(".topbar").getByText("REPLAY · SYNTHETIC FIXTURE", { exact: true })).toBeInViewport();
    }
    await page.getByTestId("stop-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("stop-confirm")).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("stop-dialog")).not.toBeVisible();
    await expect(page.getByTestId("stop-button")).toBeFocused();
  }
});

test("stop is always available and resume is readiness-gated", async ({ page }) => {
  test.skip(SECRET.length === 0, "OPERATOR_BOOTSTRAP_SECRET missing");
  await login(page);
  await page.getByTestId("stop-button").click();
  const confirm = page.getByTestId("stop-confirm");
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(page.getByTestId("account-status")).toContainText("PAUSED");
  await page.getByTestId("resume-button").click();
  const resumeConfirm = page.getByTestId("resume-confirm");
  await expect(resumeConfirm).toBeVisible();
  await expect(resumeConfirm).toBeEnabled();
  await resumeConfirm.click();
  await expect(page.getByTestId("account-status")).toContainText("READY");
});

test("logout revokes the server session and a reload stays logged out", async ({ page }) => {
  test.skip(SECRET.length === 0, "OPERATOR_BOOTSTRAP_SECRET missing");
  await login(page);
  await logout(page);
  await expect(page.getByTestId("login-submit")).toBeVisible();
  const session = await page.request.get("/v1/auth/session");
  expect(session.status()).toBe(401);
  await page.reload();
  await expect(page.getByTestId("login-submit")).toBeVisible();
});

test("failed logout keeps the session visible until the operator retries", async ({ page }) => {
  test.skip(SECRET.length === 0, "OPERATOR_BOOTSTRAP_SECRET missing");
  await login(page);
  await page.route("**/v1/auth/session", async (route) => {
    if (route.request().method() === "DELETE") await route.abort("connectionfailed");
    else await route.continue();
  });
  await logout(page);
  await expect(page.getByText("Log out failed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("account-status")).toBeVisible();
  expect((await page.request.get("/v1/auth/session")).status()).toBe(200);
  await page.unroute("**/v1/auth/session");
  await logout(page);
  await expect(page.getByTestId("login-submit")).toBeVisible();
  expect((await page.request.get("/v1/auth/session")).status()).toBe(401);
});
