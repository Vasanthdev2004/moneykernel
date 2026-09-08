import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "@moneykernel/contracts";
import { afterAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../../../apps/agents/src/kernel-client.ts";
import { SYSTEM_PROMPT } from "../../../apps/agents/src/prompt.ts";
import { main, parseRunnerArgs, RUNNER_VERSION, USAGE } from "../../../apps/agents/src/runner.ts";
import { AGENT_TOKEN, jsonResponse, kernelContextBody, strictContext } from "./fixtures.ts";

const workDir = mkdtempSync(join(tmpdir(), "moneykernel-runner-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

type Io = { stdout: string; stderr: string };

function kernelStub(): { fetch: FetchLike; posts: Array<{ key: string | undefined; body: string }> } {
  const posts: Array<{ key: string | undefined; body: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== `Bearer ${AGENT_TOKEN}`) {
      return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "bad token", request_id: "r" } }, 401);
    }
    if (url.endsWith("/v1/agent/context")) return jsonResponse(kernelContextBody());
    if (url.endsWith("/v1/agent/intents")) {
      posts.push({ key: headers["idempotency-key"], body: String(init?.body) });
      return jsonResponse({ intent_id: "int_1", decision: "APPROVED" }, 201);
    }
    return jsonResponse({ error: { code: "NOT_FOUND", message: url, request_id: "r" } }, 404);
  };
  return { fetch, posts };
}

async function run(argv: string[], env: Record<string, string | undefined>, fetch?: FetchLike) {
  const io: Io = { stdout: "", stderr: "" };
  const code = await main(argv, env, {
    stdout: (text) => {
      io.stdout += text;
    },
    stderr: (text) => {
      io.stderr += text;
    },
    fetch,
  });
  return { code, ...io };
}

describe("runner CLI", () => {
  it("exports a version and parses the documented flags", () => {
    expect(RUNNER_VERSION).toBe("0.1.0");
    const args = parseRunnerArgs([
      "--role",
      "inventory-guard",
      "--provider",
      "scripted",
      "--dry-run",
      "--trace-dir",
      "t",
    ]);
    expect(args).toMatchObject({ role: "inventory-guard", provider: "scripted", dryRun: true, traceDir: "t" });
    expect(args.kernel).toBe("http://127.0.0.1:8080");
    expect(() => parseRunnerArgs(["--role", "alpha", "--provider", "openai"])).toThrow(/unknown provider/);
    expect(() => parseRunnerArgs(["--role", "chaos"])).toThrow(/unknown role/);
    expect(() => parseRunnerArgs(["--role", "alpha", "--bogus"])).toThrow();
  });

  it("prints usage on --help and fails closed on missing role, token, or provider", async () => {
    expect(await run(["--help"], {})).toMatchObject({ code: 0, stdout: USAGE });
    const noRole = await run([], {});
    expect(noRole.code).toBe(1);
    expect(noRole.stderr).toMatch(/--role is required/);
    const noToken = await run(["--role", "alpha", "--provider", "scripted"], {});
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toMatch(/MK_AGENT_TOKEN/);
    const noProvider = await run(["--role", "alpha"], { MK_AGENT_TOKEN: AGENT_TOKEN }, kernelStub().fetch);
    expect(noProvider.code).toBe(1);
    expect(noProvider.stderr).toMatch(/--provider is required/);
    const noKey = await run(["--role", "alpha", "--provider", "anthropic", "--model", "m"], {
      MK_AGENT_TOKEN: AGENT_TOKEN,
    });
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toMatch(/MODEL_API_KEY is required/);
  });

  it("dumps the bounded context for a supported agent session with --context-out and proposes nothing", async () => {
    const out = join(workDir, "context.json");
    const stub = kernelStub();
    const result = await run(["--role", "alpha", "--context-out", out], { MK_AGENT_TOKEN: AGENT_TOKEN }, stub.fetch);
    expect(result.code).toBe(0);
    expect(stub.posts).toHaveLength(0);
    const dump = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(dump.context).toEqual(strictContext());
    expect(dump.context_hash).toBe(hashCanonical(strictContext()));
    expect(dump.role).toBe("alpha");
    expect(dump.system_prompt).toBe(SYSTEM_PROMPT);
    expect(JSON.stringify(dump)).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(dump)).not.toContain("payload_hash");
    expect(result.stderr).toContain("nothing was proposed");
  });

  it("runs a scripted provider end to end, prints the trace, and writes it to the trace directory", async () => {
    const traceDir = join(workDir, "runs");
    const stub = kernelStub();
    const result = await run(
      ["--role", "alpha", "--provider", "scripted", "--token", AGENT_TOKEN, "--trace-dir", traceDir],
      { MODEL_API_KEY: "sk-ant-not-used-here" },
      stub.fetch,
    );
    expect(result.code).toBe(0);
    const trace = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(trace.output_kind).toBe("NO_ACTION");
    expect(trace.provider_source).toBe("SCRIPTED");
    expect(stub.posts).toHaveLength(0);
    expect(result.stdout).not.toContain(AGENT_TOKEN);
    expect(result.stdout).not.toContain("sk-ant-not-used-here");
    expect(result.stderr).toContain(traceDir);
  });

  it("exits 2 and submits nothing when the provider cannot produce a proposal", async () => {
    const stub = kernelStub();
    const result = await run(
      ["--role", "alpha", "--provider", "agent-session", "--proposal", join(workDir, "absent.json")],
      { MK_AGENT_TOKEN: AGENT_TOKEN },
      stub.fetch,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/PROPOSAL_FILE_INVALID/);
    expect(stub.posts).toHaveLength(0);
  });
});
