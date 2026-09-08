import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, KernelError } from "../../../apps/web/src/api.ts";

afterEach(() => vi.unstubAllGlobals());

const client = () => createClient({ getCsrf: () => "test-csrf", onUnauthorized: () => undefined });

describe("operator client transport", () => {
  it("does not announce an empty logout body as JSON", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _options?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await client().logout();
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.method).toBe("DELETE");
    expect(new Headers(options?.headers).get("content-type")).toBeNull();
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe("test-csrf");
  });

  it("retains retry eligibility when a mutation response body is lost after its headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("socket closed during body"));
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const error = await client()
      .stop(undefined, "same-logical-stop")
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(KernelError);
    expect(error).toMatchObject({ status: 0, code: "NETWORK", retriable: true });
  });
});
