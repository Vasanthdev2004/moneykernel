import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "@moneykernel/contracts";
import { afterAll, describe, expect, it } from "vitest";
import type { StrategyProvider } from "../../../apps/agents/src/provider.ts";
import { AgentSessionProvider } from "../../../apps/agents/src/providers/agent-session.ts";
import { RECORDED_LABEL, RecordedProvider } from "../../../apps/agents/src/providers/recorded.ts";
import { ScriptedProvider } from "../../../apps/agents/src/providers/scripted.ts";
import { deriveRunId, idempotencyKeyFor, runOnce, tracePath } from "../../../apps/agents/src/run.ts";
import {
  AGENT_TOKEN,
  BUY_PROPOSAL,
  FakeKernelClient,
  kernelContextBody,
  LEASE_ID,
  NO_ACTION,
  SNAPSHOT_ID,
  strictContext,
} from "./fixtures.ts";

const clock = (): Date => new Date("2026-09-08T12:00:05.000Z");
const workDir = mkdtempSync(join(tmpdir(), "moneykernel-agents-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function writeJson(name: string, value: unknown): string {
  const path = join(workDir, name);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

describe("runOnce: one bounded strategy cycle (prd.md 16)", () => {
  it("submits a scripted PROPOSAL once with a deterministic idempotency key", async () => {
    const client = new FakeKernelClient();
    const provider = new ScriptedProvider(BUY_PROPOSAL);
    const trace = await runOnce({ client, provider, role: "alpha", clock });

    expect(client.contextCalls).toBe(1);
    expect(client.submissions).toHaveLength(1);
    const submission = client.submissions[0];
    if (submission === undefined) return;
    expect(submission.key).toMatch(/^run-[0-9a-f]{16}$/);
    expect(submission.key).toBe(idempotencyKeyFor(trace.run_id));
    expect(submission.body).toEqual({
      schema_version: "1",
      lease_id: LEASE_ID,
      symbol: "BTCUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "25" },
      limit_price: "60010",
      observation_ids: [SNAPSHOT_ID],
      rationale: BUY_PROPOSAL.rationale,
      strategy_run_id: trace.run_id,
    });

    expect(trace.output_kind).toBe("PROPOSAL");
    expect(trace.produced_at).toBe("2026-09-08T12:00:05.000Z");
    expect(trace.provider_source).toBe("SCRIPTED");
    expect(trace.model_id).toBe("scripted");
    expect(trace.prompt_version).toBe("1");
    expect(trace.context_hash).toBe(hashCanonical(strictContext()));
    expect(trace.run_id).toBe(deriveRunId(trace.context_hash, provider));
    expect(trace.validation).toBe("VALID");
    expect(trace.kernel).toEqual({ status: 201, body: { intent_id: "int_0123456789abcdef", decision: "APPROVED" } });
    expect(trace.intent).toEqual(submission.body);
    expect(trace.dry_run).toBe(false);
    expect(trace.error).toBeUndefined();
    expect(JSON.stringify(trace)).not.toContain(AGENT_TOKEN);
  });

  it("replays the same key for the same context and a different key for a different context", async () => {
    const provider = new ScriptedProvider(BUY_PROPOSAL);
    const first = await runOnce({ client: new FakeKernelClient(), provider, role: "alpha", clock });
    const again = new FakeKernelClient();
    const second = await runOnce({ client: again, provider, role: "alpha", clock });
    expect(second.run_id).toBe(first.run_id);
    expect(again.submissions[0]?.key).toBe(idempotencyKeyFor(first.run_id));

    const moved = await runOnce({
      client: new FakeKernelClient(kernelContextBody({ server_time: "2026-09-08T12:30:00.000Z" })),
      provider,
      role: "alpha",
      clock,
    });
    expect(moved.run_id).not.toBe(first.run_id);
    const otherProvider = await runOnce({
      client: new FakeKernelClient(),
      provider: { source: "LIVE_PROVIDER", modelId: "claude-test", propose: provider.propose.bind(provider) },
      role: "alpha",
      clock,
    });
    expect(otherProvider.run_id).not.toBe(first.run_id);
  });

  it("submits nothing on NO_ACTION", async () => {
    const client = new FakeKernelClient();
    const trace = await runOnce({ client, provider: new ScriptedProvider(NO_ACTION), role: "alpha", clock });
    expect(client.submissions).toHaveLength(0);
    expect(trace.output_kind).toBe("NO_ACTION");
    expect(trace.rationale).toBe(NO_ACTION.rationale);
    expect(trace.intent).toBeNull();
    expect(trace.kernel).toBeNull();
  });

  it("records a throwing provider as NO_PROPOSAL and submits nothing (prd.md 11.7)", async () => {
    const client = new FakeKernelClient();
    const failing: StrategyProvider = {
      source: "LIVE_PROVIDER",
      modelId: "claude-test",
      propose: async () => {
        throw new Error("MODEL_TIMEOUT: no complete response from the model provider within 20000ms");
      },
    };
    const trace = await runOnce({ client, provider: failing, role: "alpha", clock });
    expect(client.submissions).toHaveLength(0);
    expect(trace.output_kind).toBe("NO_PROPOSAL");
    expect(trace.error).toMatch(/^MODEL_TIMEOUT: /);
    expect(trace.validation).toBeNull();
    expect(trace.rationale).toBeNull();
    expect(trace.intent).toBeNull();
    expect(trace.usage).toEqual({ input_tokens: null, output_tokens: null });
  });

  it("returns NO_ACTION without consulting the provider when there is no active lease", async () => {
    let calls = 0;
    const counting: StrategyProvider = {
      source: "SCRIPTED",
      modelId: "scripted",
      propose: async () => {
        calls += 1;
        return new ScriptedProvider(BUY_PROPOSAL).propose();
      },
    };
    const client = new FakeKernelClient(kernelContextBody({ lease: null }));
    const trace = await runOnce({ client, provider: counting, role: "alpha", clock });
    expect(calls).toBe(0);
    expect(client.submissions).toHaveLength(0);
    expect(trace.output_kind).toBe("NO_ACTION");
    expect(trace.rationale).toBe("no active lease");
    expect(trace.validation).toBeNull();
  });

  it("refuses an agent-session proposal written against a stale context", async () => {
    const stale = writeJson("stale-proposal.json", {
      produced_by: "claude-code",
      produced_at: "2026-09-08T11:00:00.000Z",
      context_hash: "f".repeat(64),
      raw_text: JSON.stringify(BUY_PROPOSAL),
    });
    const client = new FakeKernelClient();
    const trace = await runOnce({
      client,
      provider: new AgentSessionProvider({ proposalPath: stale }),
      role: "alpha",
      clock,
    });
    expect(client.submissions).toHaveLength(0);
    expect(trace.output_kind).toBe("NO_PROPOSAL");
    expect(trace.error).toMatch(/^STALE_CONTEXT: /);
    expect(trace.provider_source).toBe("SUPPORTED_AGENT_SESSION");
    expect(trace.model_id).toBe("claude-code");
  });

  it("submits an agent-session proposal whose context hash matches the current context", async () => {
    const fresh = writeJson("fresh-proposal.json", {
      produced_by: "claude-code",
      produced_at: "2026-09-08T11:59:00.000Z",
      context_hash: hashCanonical(strictContext()),
      raw_text: `\`\`\`json\n${JSON.stringify(BUY_PROPOSAL)}\n\`\`\``,
    });
    const client = new FakeKernelClient();
    const trace = await runOnce({
      client,
      provider: new AgentSessionProvider({ proposalPath: fresh }),
      role: "alpha",
      clock,
    });
    expect(client.submissions).toHaveLength(1);
    expect(trace.output_kind).toBe("PROPOSAL");
    expect(trace.validation).toBe("VALID");
    expect(() => new AgentSessionProvider({ proposalPath: join(workDir, "missing.json") })).toThrow(
      /PROPOSAL_FILE_INVALID/,
    );
  });

  it("replays a recorded model response under its label", async () => {
    const recording = writeJson("recording.json", {
      model_id: "claude-recorded",
      recorded_at: "2026-09-07T10:00:00.000Z",
      raw_text: JSON.stringify(NO_ACTION),
    });
    const provider = new RecordedProvider({ recordingPath: recording });
    expect(provider.label).toBe(RECORDED_LABEL);
    expect(RECORDED_LABEL).toBe("RECORDED MODEL RESPONSE");
    const client = new FakeKernelClient();
    const trace = await runOnce({ client, provider, role: "inventory-guard", clock });
    expect(trace.provider_source).toBe("RECORDED");
    expect(trace.model_id).toBe("claude-recorded");
    expect(trace.role).toBe("inventory-guard");
    expect(trace.output_kind).toBe("NO_ACTION");
    expect(client.submissions).toHaveLength(0);
  });

  it("never calls submitIntent in dry-run mode", async () => {
    const client = new FakeKernelClient();
    client.submitError = new Error("submitIntent must not be called in dry-run");
    const trace = await runOnce({
      client,
      provider: new ScriptedProvider(BUY_PROPOSAL),
      role: "alpha",
      clock,
      dryRun: true,
    });
    expect(client.submissions).toHaveLength(0);
    expect(trace.dry_run).toBe(true);
    expect(trace.output_kind).toBe("PROPOSAL");
    expect(trace.intent).not.toBeNull();
    expect(trace.kernel).toBeNull();
    expect(trace.error).toBeUndefined();
  });

  it("keeps the intent and records a failed submission instead of retrying", async () => {
    const client = new FakeKernelClient();
    client.submitError = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    const trace = await runOnce({ client, provider: new ScriptedProvider(BUY_PROPOSAL), role: "alpha", clock });
    expect(trace.output_kind).toBe("PROPOSAL");
    expect(trace.kernel).toBeNull();
    expect(trace.error).toMatch(/^KERNEL_SUBMIT_FAILED: /);
    expect(trace.intent).not.toBeNull();
  });

  it("writes the trace file under the trace directory without any secret", async () => {
    const traceDir = join(workDir, "model-runs", "nested");
    const client = new FakeKernelClient();
    const trace = await runOnce({
      client,
      provider: new ScriptedProvider(BUY_PROPOSAL),
      role: "alpha",
      clock,
      traceDir,
    });
    const path = tracePath(traceDir, trace);
    expect(path).toBe(join(traceDir, `20260908T120005Z-${trace.run_id}.json`));
    expect(existsSync(path)).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(JSON.parse(written)).toEqual(trace);
    expect(written).not.toContain(AGENT_TOKEN);
  });
});
