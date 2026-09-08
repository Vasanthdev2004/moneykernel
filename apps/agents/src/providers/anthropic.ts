import { z } from "zod";
import type { FetchLike } from "../kernel-client.ts";
import { type AgentRole, renderUserMessage, SYSTEM_PROMPT } from "../prompt.ts";
import {
  errorMessage,
  formatIssues,
  NO_TOKEN_USAGE,
  ProviderFailure,
  type ProviderResult,
  type StrategyContext,
  type StrategyProvider,
  type TokenUsage,
  validateOutput,
} from "../provider.ts";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** prd.md 16.4: 20-second provider timeout, one repair attempt, small explicit token budget. */
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_TOKENS = 600;

export type AnthropicProviderOptions = {
  apiKey: string;
  modelId: string;
  /** Which prd.md 16.1 role statement the user message carries. */
  role?: AgentRole;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxTokens?: number;
};

type ChatMessage = { role: "user" | "assistant"; content: string };
type ModelReply = { text: string; stopReason: string | null; usage: TokenUsage };

const MessagesResponseSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().int().nullable().optional(),
      output_tokens: z.number().int().nullable().optional(),
    })
    .optional(),
});

function addTokens(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function describeFailure(reply: ModelReply, error: string): string {
  return reply.stopReason !== null && reply.stopReason !== "end_turn"
    ? `${error} (the response ended with stop_reason=${reply.stopReason})`
    : error;
}

/**
 * Live provider over the Messages API using global fetch (no SDK). One
 * request, at most one schema-repair round, never an automatic retry, and a
 * hard timeout. The API key is held privately and scrubbed from every message
 * that could carry provider output.
 */
export class AnthropicProvider implements StrategyProvider {
  readonly source = "LIVE_PROVIDER" as const;
  readonly modelId: string;
  readonly role: AgentRole;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;

  constructor(options: AnthropicProviderOptions) {
    if (options.apiKey.length === 0) throw new Error("MODEL_API_KEY_MISSING: the live provider needs an API key");
    if (options.modelId.length === 0) throw new Error("MODEL_ID_MISSING: the live provider needs a model id");
    this.modelId = options.modelId;
    this.role = options.role ?? "alpha";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async propose(context: StrategyContext): Promise<ProviderResult> {
    const started = performance.now();
    const conversation: ChatMessage[] = [{ role: "user", content: renderUserMessage(context, this.role) }];
    let repairAttempts = 0;
    let usage: TokenUsage = NO_TOKEN_USAGE;
    let validation: "INVALID" | null = null;
    try {
      const first = await this.#call(conversation);
      usage = first.usage;
      const firstCheck = validateOutput(first.text);
      if (firstCheck.ok) {
        return {
          output: firstCheck.output,
          raw_text: first.text,
          latency_ms: Math.round(performance.now() - started),
          repair_attempts: 0,
          usage: first.usage,
          validation: "VALID",
        };
      }

      validation = "INVALID";
      // Exactly one schema-repair round (prd.md 16.2); the failure goes back as data.
      if (first.text.trim().length > 0) conversation.push({ role: "assistant", content: first.text });
      conversation.push({
        role: "user",
        content: `Your previous output failed validation: ${describeFailure(first, firstCheck.error)}. Return only the JSON object.`,
      });
      repairAttempts = 1;
      const second = await this.#call(conversation);
      usage = {
        input_tokens: addTokens(first.usage.input_tokens, second.usage.input_tokens),
        output_tokens: addTokens(first.usage.output_tokens, second.usage.output_tokens),
      };
      const secondCheck = validateOutput(second.text);
      if (secondCheck.ok) {
        return {
          output: secondCheck.output,
          raw_text: second.text,
          latency_ms: Math.round(performance.now() - started),
          repair_attempts: 1,
          usage,
          validation: "REPAIRED",
        };
      }
      throw new Error(`MODEL_OUTPUT_INVALID: ${describeFailure(second, secondCheck.error)} (after 1 repair attempt)`);
    } catch (error) {
      throw new ProviderFailure(this.#scrub(errorMessage(error)), {
        latency_ms: Math.round(performance.now() - started),
        repair_attempts: repairAttempts,
        validation,
        usage,
      });
    }
  }

  async #call(messages: ChatMessage[]): Promise<ModelReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const response = await this.#fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "x-api-key": this.#apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          max_tokens: this.maxTokens,
          system: SYSTEM_PROMPT,
          messages,
        }),
        signal: controller.signal,
      });
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`MODEL_TIMEOUT: no complete response from the model provider within ${this.timeoutMs}ms`);
      }
      throw new Error(`MODEL_REQUEST_FAILED: ${this.#scrub(errorMessage(error))}`);
    } finally {
      clearTimeout(timer);
    }
    if (!ok) throw new Error(`MODEL_HTTP_ERROR: status ${status} ${this.#scrub(text).slice(0, 300)}`.trimEnd());

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("MODEL_RESPONSE_INVALID: the provider returned a non-JSON body");
    }
    const parsed = MessagesResponseSchema.safeParse(json);
    if (!parsed.success) throw new Error(`MODEL_RESPONSE_INVALID: ${formatIssues(parsed.error)}`);
    return {
      text: parsed.data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      stopReason: parsed.data.stop_reason ?? null,
      usage: {
        input_tokens: parsed.data.usage?.input_tokens ?? null,
        output_tokens: parsed.data.usage?.output_tokens ?? null,
      },
    };
  }

  #scrub(text: string): string {
    return text.split(this.#apiKey).join("[redacted]");
  }
}
