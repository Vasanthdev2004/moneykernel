import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DecisionResponse, DecisionResponseSchema } from "@moneykernel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts", "demo-scene.ts");
const directory = mkdtempSync(join(tmpdir(), "moneykernel-scene-cli-"));
const seedPath = join(directory, "seed.json");
const secret = `mka_${"S".repeat(40)}`;
const operatorToken = `mko_${"T".repeat(40)}`;
writeFileSync(
  seedPath,
  JSON.stringify({
    agents: ["agent_alpha", "agent_inventory_guard", "agent_chaos"].map((fixture_agent_id) => ({
      fixture_agent_id,
      token: secret,
      lease_id: "lease_fixture",
    })),
  }),
);
afterAll(() => {
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("unexpected test directory");
  rmSync(directory, { recursive: true, force: true });
});

type Reply = { status?: number; body?: unknown; raw?: string };
type Request = { method: string; path: string; body: Record<string, unknown> };
type Handler = (request: Request) => Reply;
const context = () => ({
  account: { environment: "REPLAY" },
  observations: ["SOLUSDT", "BTCUSDT"].map((symbol) => ({ symbol, snapshot_id: `snapshot_${symbol}` })),
});

function decision(
  options: {
    quantity?: string;
    price?: string;
    symbol?: string;
    side?: "BUY" | "SELL";
    outcome?: DecisionResponse["outcome"];
    state?: DecisionResponse["state"];
    id?: string;
    reasons?: DecisionResponse["reason_codes"];
  } = {},
): DecisionResponse {
  const denied = options.outcome === "DENY";
  const id = options.id ?? "1";
  return DecisionResponseSchema.parse({
    intent_id: `intent_${id}`,
    proposal_id: denied ? null : `proposal_${id}`,
    proposal_revision: denied ? null : 1,
    outcome: options.outcome ?? "COUNTERPROPOSE",
    state: options.state ?? (denied ? "DENIED" : "COLLECTING"),
    reason_codes: options.reasons ?? (denied ? ["AGENT_QUARANTINED"] : ["SYMBOL_EXPOSURE_LIMIT"]),
    candidate: denied
      ? null
      : {
          symbol: options.symbol ?? "SOLUSDT",
          side: options.side ?? "BUY",
          order_type: "LIMIT_IOC",
          quantity: options.quantity ?? "0.27",
          limit_price: options.price ?? "100",
          notional_quote: "27",
          fee_reserve_quote: "0.027",
          total_quote_reserved: "27.027",
          base_reserved: "0",
          reference_mark: options.price ?? "100",
        },
    authority: { policy_version: 1, lease_revision: 1, account_epoch: 1, requires_operator_approval: !denied },
    provenance: {
      execution_mode: "REPLAY",
      market_source: "SYNTHETIC_FIXTURE",
      model_source: "SCRIPTED",
      execution_source: "PAPER",
    },
    receipt_id: `receipt_${id}`,
    proposal_hash: denied ? null : "a".repeat(64),
    expires_at: denied ? null : "2026-09-08T12:02:00Z",
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function withApi(handler: Handler, check: (url: string, requests: Request[]) => Promise<void>) {
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    const captured = { method: request.method ?? "GET", path: request.url ?? "", body: await readBody(request) };
    requests.push(captured);
    const reply = handler(captured);
    response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing API address");
  try {
    await check(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

async function run(url: string, scene = "a", options: { eof?: boolean; args?: string[] } = {}) {
  return new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [script, ...(options.args ?? [scene, "--seed", seedPath]), "--kernel", url], {
      cwd: repoRoot,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        OPERATOR_BOOTSTRAP_SECRET: "fake-operator-bootstrap-secret",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let entered = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 6000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!options.eof && !entered && stdout.includes("press Enter to continue")) {
        entered = true;
        child.stdin.write("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      done({ code, timedOut, stdout, stderr });
    });
    if (options.eof) child.stdin.end();
  });
}

describe("manual demo CLI verifies the scene before instructing the operator", () => {
  it.each([["unknown"], ["a", "b"], ["a", "--bogus"]])(
    "rejects invalid scene arguments %j before files or requests",
    async (...args) => {
      await withApi(
        () => ({ body: {} }),
        async (url, requests) => {
          const result = await run(url, "a", { args: [...args, "--seed", "missing-seed-file"] });
          expect(result).toMatchObject({ code: 1, timedOut: false });
          expect(result.stderr).toContain("usage:");
          expect(result.stderr).not.toContain("missing-seed-file");
          expect(requests).toHaveLength(0);
        },
      );
    },
  );

  it.each([401, 500])("does not submit an intent after HTTP %s context", async (status) => {
    await withApi(
      () => ({ status, body: { message: secret } }),
      async (url, requests) => {
        const result = await run(url);
        expect(result).toMatchObject({ code: 1, timedOut: false });
        expect(result.stderr).toContain(`agent context failed (HTTP ${status})`);
        expect(result.stdout + result.stderr).not.toContain(secret);
        expect(result.stdout).not.toContain("press Enter");
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("does not print approval instructions when a valid context is followed by intent HTTP 422", async () => {
    await withApi(
      ({ path }) =>
        path.endsWith("context") ? { body: context() } : { status: 422, body: { error: { message: secret } } },
      async (url) => {
        const result = await run(url);
        expect(result).toMatchObject({ code: 1, timedOut: false });
        expect(result.stderr).toContain("intent submission failed (HTTP 422)");
        expect(result.stdout).not.toContain("Console:");
        expect(result.stdout + result.stderr).not.toContain(secret);
      },
    );
  });

  it("rejects malformed JSON, malformed decisions, and an unexpected recorded denial without echoing payloads", async () => {
    for (const reply of [
      { raw: `not JSON ${secret}` },
      { body: { outcome: secret } },
      { body: decision({ outcome: "DENY" }) },
    ]) {
      await withApi(
        ({ path }) => (path.endsWith("context") ? { body: context() } : { status: 201, ...reply }),
        async (url) => {
          const result = await run(url);
          expect(result).toMatchObject({ code: 1, timedOut: false });
          expect(result.stdout).not.toContain("Console:");
          expect(result.stdout + result.stderr).not.toContain(secret);
        },
      );
    }
  });

  it("allows scene A's verified counterproposal and Enter confirmation", async () => {
    await withApi(
      ({ path }) => (path.endsWith("context") ? { body: context() } : { status: 201, body: decision() }),
      async (url) => {
        const result = await run(url);
        expect(result).toMatchObject({ code: 0, timedOut: false, stderr: "" });
        expect(result.stdout).toContain("exact candidate (0.27 SOL)");
      },
    );
  });

  it("fails promptly on EOF at the operator pause", async () => {
    await withApi(
      ({ path }) => (path.endsWith("context") ? { body: context() } : { status: 201, body: decision() }),
      async (url) => {
        const result = await run(url, "a", { eof: true });
        expect(result).toMatchObject({ code: 1, timedOut: false });
        expect(result.stderr).toContain("input closed before confirmation");
      },
    );
  });

  it.each(["login", "fault"])("stops scene D when %s fails", async (failure) => {
    await withApi(
      ({ path }) => {
        if (path.endsWith("context")) return { body: context() };
        if (path.endsWith("intents"))
          return { status: 201, body: decision({ outcome: "ALLOW_PROPOSAL", quantity: "0.2" }) };
        if (path.endsWith("session"))
          return failure === "login"
            ? { status: 401, body: { message: secret } }
            : { status: 201, body: { session_token: operatorToken } };
        return { status: 403, body: { note: secret } };
      },
      async (url, requests) => {
        const result = await run(url, "d");
        expect(result).toMatchObject({ code: 1, timedOut: false });
        expect(result.stdout).not.toContain("fault armed:");
        expect(result.stdout).not.toContain("Console:");
        expect(result.stdout + result.stderr).not.toContain(secret);
        if (failure === "login") expect(requests.some((r) => r.path.endsWith("faults"))).toBe(false);
      },
    );
  });

  it("requires scene D's fault acknowledgement and never echoes its free-form note", async () => {
    for (const { correct, held } of [
      { correct: false, held: true },
      { correct: true, held: false },
      { correct: true, held: true },
    ]) {
      await withApi(
        ({ path }) => {
          if (path.endsWith("context")) return { body: context() };
          if (path.endsWith("intents"))
            return { status: 201, body: decision({ outcome: "ALLOW_PROPOSAL", quantity: "0.2" }) };
          if (path.endsWith("session")) return { status: 201, body: { session_token: operatorToken } };
          return {
            status: 201,
            body: {
              kind: "DROP_RESPONSE_AFTER_ACCEPT",
              proposal_id: correct ? "proposal_1" : "proposal_other",
              client_order_id: `mk_${"a".repeat(32)}`,
              hold_queries_until_restart: held,
              note: secret,
            },
          };
        },
        async (url, requests) => {
          const result = await run(url, "d");
          expect(result).toMatchObject({ code: correct && held ? 0 : 1, timedOut: false });
          expect(result.stdout + result.stderr).not.toContain(secret);
          expect(result.stdout.includes("fault armed:")).toBe(correct && held);
          expect(requests.find((r) => r.path.endsWith("faults"))?.body.hold_queries_until_restart).toBe(true);
        },
      );
    }
  });

  it("does not claim conflict success when the readback never reaches CONFLICT_HELD", async () => {
    let submitted = 0;
    await withApi(
      ({ path, method }) => {
        if (path.endsWith("context")) return { body: context() };
        const sell = method === "POST" && ++submitted === 2;
        return {
          status: method === "POST" ? 201 : 200,
          body: decision({
            id: sell ? "2" : "1",
            outcome: "ALLOW_PROPOSAL",
            quantity: sell ? "0.0002" : "0.0005",
            price: "100000",
            symbol: "BTCUSDT",
            side: sell ? "SELL" : "BUY",
          }),
        };
      },
      async (url) => {
        const result = await run(url, "b");
        expect(result).toMatchObject({ code: 1, timedOut: false });
        expect(result.stderr).toContain("did not become CONFLICT_HELD");
        expect(result.stdout).not.toContain("Console:");
      },
    );
  }, 8000);

  it("does not claim quarantine when request eleven still acquires a proposal", async () => {
    await withApi(
      ({ path }) =>
        path.endsWith("context")
          ? { body: context() }
          : { status: 201, body: decision({ outcome: "ALLOW_PROPOSAL", quantity: "0.07" }) },
      async (url, requests) => {
        const result = await run(url, "c");
        expect(result).toMatchObject({ code: 1, timedOut: false });
        expect(result.stderr).toContain("not denied for AGENT_QUARANTINED");
        expect(result.stdout).not.toContain("Console:");
        expect(requests.filter((r) => r.method === "POST")).toHaveLength(11);
      },
    );
  }, 8000);

  it("continues scene B only after both recorded intents are conflict-held", async () => {
    const decisions = new Map<string, DecisionResponse>();
    await withApi(
      ({ path, method, body }) => {
        if (path.endsWith("context")) return { body: context() };
        if (method === "POST") {
          const sell = body.side === "SELL";
          const candidate = decision({
            id: sell ? "2" : "1",
            outcome: "ALLOW_PROPOSAL",
            quantity: sell ? "0.0002" : "0.0005",
            price: "100000",
            symbol: "BTCUSDT",
            side: sell ? "SELL" : "BUY",
          });
          decisions.set(candidate.intent_id, { ...candidate, state: "CONFLICT_HELD" });
          return { status: 201, body: candidate };
        }
        return { body: decisions.get(path.split("/").at(-1) ?? "") };
      },
      async (url, requests) => {
        const result = await run(url, "b");
        expect(result).toMatchObject({ code: 0, timedOut: false, stderr: "" });
        expect(result.stdout).toContain("both CONFLICT_HELD");
        expect(requests.filter((r) => r.path.includes("/intents/")).length).toBe(2);
      },
    );
  });

  it.each([true, false])(
    "requires a denied post-quarantine request (laterDenied=%s)",
    async (laterDenied) => {
      let submitted = 0;
      await withApi(
        ({ path }) => {
          if (path.endsWith("context")) return { body: context() };
          submitted += 1;
          const denied = submitted === 11 || (submitted === 12 && laterDenied);
          return { status: 201, body: decision({ outcome: denied ? "DENY" : "ALLOW_PROPOSAL", quantity: "0.07" }) };
        },
        async (url) => {
          const result = await run(url, "c");
          expect(result).toMatchObject({ code: laterDenied ? 0 : 1, timedOut: false });
          expect(submitted).toBe(12);
          if (!laterDenied) expect(result.stderr).toContain("not denied for AGENT_QUARANTINED");
        },
      );
    },
    8000,
  );
});
