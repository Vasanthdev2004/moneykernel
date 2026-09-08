import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { type FetchLike, HttpKernelClient, KernelClientError } from "../../../apps/agents/src/kernel-client.ts";
import { AGENT_TOKEN, jsonResponse, kernelContextBody } from "./fixtures.ts";

type Call = { url: string; init: RequestInit };

function stubFetch(reply: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return reply(call);
  };
  return { fetch, calls };
}

const headerOf = (call: Call, name: string): string | undefined => (call.init.headers as Record<string, string>)[name];

describe("HttpKernelClient: the agent HTTP API (prd.md 15.2)", () => {
  it("reads the context with a bearer token and returns the parsed body", async () => {
    const stub = stubFetch(() => jsonResponse(kernelContextBody()));
    const client = new HttpKernelClient({
      baseUrl: "http://127.0.0.1:8080/",
      agentToken: AGENT_TOKEN,
      fetch: stub.fetch,
    });
    const body = await client.getContext();
    expect(body).toEqual(kernelContextBody());
    expect(stub.calls[0]?.url).toBe("http://127.0.0.1:8080/v1/agent/context");
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(headerOf(stub.calls[0] as Call, "authorization")).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it("submits an intent with Idempotency-Key and JSON content type", async () => {
    const stub = stubFetch(() => jsonResponse({ intent_id: "int_1", decision: "APPROVED" }, 201));
    const client = new HttpKernelClient({
      baseUrl: "http://127.0.0.1:8080",
      agentToken: AGENT_TOKEN,
      fetch: stub.fetch,
    });
    const result = await client.submitIntent("run-0123456789abcdef", { schema_version: "1" });
    expect(result).toEqual({ status: 201, body: { intent_id: "int_1", decision: "APPROVED" } });
    const call = stub.calls[0] as Call;
    expect(call.url).toBe("http://127.0.0.1:8080/v1/agent/intents");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call, "idempotency-key")).toBe("run-0123456789abcdef");
    expect(headerOf(call, "content-type")).toBe("application/json");
    expect(headerOf(call, "authorization")).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(call.init.body).toBe('{"schema_version":"1"}');
  });

  it("returns kernel decisions as data, including non-2xx responses", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "different payload", request_id: "r1" } }, 409),
    );
    const client = new HttpKernelClient({
      baseUrl: "http://127.0.0.1:8080",
      agentToken: AGENT_TOKEN,
      fetch: stub.fetch,
    });
    const result = await client.submitIntent("run-0123456789abcdef", {});
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("fails context reads with the kernel's error code and never the token, even when echoed", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: `bad token ${AGENT_TOKEN}`, request_id: "r2" } }, 401),
    );
    const client = new HttpKernelClient({
      baseUrl: "http://127.0.0.1:8080",
      agentToken: AGENT_TOKEN,
      fetch: stub.fetch,
    });
    const failure = await client.getContext().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(KernelClientError);
    const message = (failure as KernelClientError).message;
    expect(message).toMatch(/^KERNEL_CONTEXT_FAILED: HTTP 401 UNAUTHENTICATED/);
    expect(message).not.toContain(AGENT_TOKEN);
    expect((failure as KernelClientError).status).toBe(401);
  });

  it("reports an unreachable kernel without the token and never exposes it through inspection", async () => {
    const unreachable: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED (token ${AGENT_TOKEN})`);
    };
    const client = new HttpKernelClient({ baseUrl: "http://127.0.0.1:1", agentToken: AGENT_TOKEN, fetch: unreachable });
    const failure = await client.getContext().then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as Error).message).toMatch(/^KERNEL_UNREACHABLE: GET \/v1\/agent\/context/);
    expect((failure as Error).message).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(client)).not.toContain(AGENT_TOKEN);
    expect(inspect(client)).not.toContain(AGENT_TOKEN);
    expect(() => new HttpKernelClient({ baseUrl: "http://127.0.0.1:8080", agentToken: "" })).toThrow(
      /AGENT_TOKEN_MISSING/,
    );
  });
});
