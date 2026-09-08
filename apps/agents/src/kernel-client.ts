import { errorMessage } from "./provider.ts";

/** Minimal fetch shape so tests can stub the network without touching globals. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type KernelResponse = { status: number; body: unknown };

/** The only two kernel calls a runner makes (prd.md 15.2): read its own context, submit one intent. */
export interface KernelClient {
  getContext(): Promise<unknown>;
  submitIntent(idempotencyKey: string, body: unknown): Promise<KernelResponse>;
}

export class KernelClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "KernelClientError";
    this.status = status;
    this.body = body;
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return ` ${String(code ?? "")} ${String(message ?? "")}`.trimEnd();
    }
  }
  return "";
}

export type HttpKernelClientOptions = { baseUrl: string; agentToken: string; fetch?: FetchLike };

/**
 * Authenticated agent HTTP client. The bearer token lives in a private field:
 * it is never logged, never serialized, and never part of an error message.
 */
export class HttpKernelClient implements KernelClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(options: HttpKernelClientOptions) {
    if (options.agentToken.length === 0) throw new Error("AGENT_TOKEN_MISSING: an agent bearer token is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.agentToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async getContext(): Promise<unknown> {
    const response = await this.#request("GET", "/v1/agent/context");
    const body = await readBody(response);
    if (!response.ok) {
      throw new KernelClientError(
        `KERNEL_CONTEXT_FAILED: HTTP ${response.status}${this.#scrub(describeError(body))}`,
        response.status,
        body,
      );
    }
    return body;
  }

  async submitIntent(idempotencyKey: string, body: unknown): Promise<KernelResponse> {
    const response = await this.#request("POST", "/v1/agent/intents", {
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await readBody(response) };
  }

  async #request(method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
    try {
      return await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json", ...init.headers },
        body: init.body,
      });
    } catch (error) {
      throw new KernelClientError(
        `KERNEL_UNREACHABLE: ${method} ${path}: ${this.#scrub(errorMessage(error))}`,
        0,
        null,
      );
    }
  }

  /** Defense in depth: even an echoing server cannot get the token into a message. */
  #scrub(text: string): string {
    return text.split(this.#token).join("[redacted]");
  }
}
