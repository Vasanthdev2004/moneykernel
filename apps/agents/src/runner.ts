/**
 * Strategy runner CLI (prd.md 16). It holds no operator tokens and no exchange
 * access: it reads the agent's own bounded context from the kernel and submits
 * at most one intent per run through the authenticated agent HTTP API.
 *
 *   node apps/agents/src/runner.ts --role alpha --provider scripted --dry-run
 */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hashCanonical } from "@moneykernel/contracts";
import { z } from "zod";
import { readJsonFile } from "./json-file.ts";
import { type FetchLike, HttpKernelClient } from "./kernel-client.ts";
import {
  type AgentRole,
  PROMPT_VERSION,
  parseAgentRole,
  renderUserMessage,
  roleStatement,
  SYSTEM_PROMPT,
} from "./prompt.ts";
import { contextFromKernel, errorMessage, ProposalOutputSchema, type StrategyProvider } from "./provider.ts";
import { AgentSessionProvider } from "./providers/agent-session.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { RECORDED_LABEL, RecordedProvider } from "./providers/recorded.ts";
import { SCRIPTED_NO_ACTION, ScriptedProvider } from "./providers/scripted.ts";
import { runOnce, tracePath } from "./run.ts";

export const RUNNER_VERSION = "0.1.0";

/** Shape of a `--context-out` dump as far as `--context-in` needs it. */
const ContextDumpSchema = z.object({ context: z.unknown() });
export const DEFAULT_KERNEL_URL = "http://127.0.0.1:8080";
export const DEFAULT_TRACE_DIR = ".moneykernel/model-runs";

const PROVIDERS = ["scripted", "recorded", "anthropic", "agent-session"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const USAGE = `MoneyKernel strategy runner v${RUNNER_VERSION} (prd.md 16)

Usage: node apps/agents/src/runner.ts --role <alpha|inventory-guard> --provider <name> [options]

  --kernel <url>        kernel base URL (default ${DEFAULT_KERNEL_URL})
  --token <mka_...>     agent bearer token; prefer the MK_AGENT_TOKEN environment variable
  --provider <name>     ${PROVIDERS.join(" | ")}
  --role <role>         alpha | inventory-guard: which prd.md 16.1 role statement the prompt carries
  --script <path>       scripted: JSON ProposalOutput to return (default: NO_ACTION)
  --recording <path>    recorded: JSON {model_id, recorded_at, raw_text}; replays are labeled ${RECORDED_LABEL}
  --model <id>          anthropic: model id (or MODEL_ID); the key is read only from MODEL_API_KEY
  --proposal <path>     agent-session: JSON {produced_by, produced_at, context_hash, raw_text}
  --context-out <path>  write the bounded context, its hash, the role and the system prompt, then exit without proposing
  --context-in <path>   propose and submit against that dump instead of fetching a fresh context (agent-session route;
                        the kernel still judges observation freshness)
  --dry-run             run the provider but never submit the intent
  --trace-dir <dir>     where run traces are written (default ${DEFAULT_TRACE_DIR})
  --help

Prints the run trace JSON to stdout. Traces never contain the agent token or an API key.
Exit codes: 0 NO_ACTION or PROPOSAL; 2 NO_PROPOSAL (timeout, invalid output, stale session) or a failed
submission; 1 usage, configuration, or kernel errors.
`;

export type RunnerArgs = {
  kernel: string;
  token: string | undefined;
  provider: ProviderName | undefined;
  role: AgentRole;
  proposal: string | undefined;
  recording: string | undefined;
  script: string | undefined;
  model: string | undefined;
  contextOut: string | undefined;
  contextIn: string | undefined;
  dryRun: boolean;
  traceDir: string;
  help: boolean;
};

function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Pure argv parsing; unknown flags and positionals are errors. */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      kernel: { type: "string", default: DEFAULT_KERNEL_URL },
      token: { type: "string" },
      provider: { type: "string" },
      role: { type: "string" },
      proposal: { type: "string" },
      recording: { type: "string" },
      script: { type: "string" },
      model: { type: "string" },
      "context-out": { type: "string" },
      "context-in": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "trace-dir": { type: "string", default: DEFAULT_TRACE_DIR },
      help: { type: "boolean", default: false },
    },
  });
  const help = values.help === true;
  if (values.provider !== undefined && !isProviderName(values.provider)) {
    throw new Error(`unknown provider "${values.provider}"; expected one of ${PROVIDERS.join(", ")}`);
  }
  if (!help && values.role === undefined) throw new Error("--role is required (alpha | inventory-guard)");
  return {
    kernel: values.kernel ?? DEFAULT_KERNEL_URL,
    token: values.token,
    provider: values.provider,
    role: values.role === undefined ? "alpha" : parseAgentRole(values.role),
    proposal: values.proposal,
    recording: values.recording,
    script: values.script,
    model: values.model,
    contextOut: values["context-out"],
    contextIn: values["context-in"],
    dryRun: values["dry-run"] === true,
    traceDir: values["trace-dir"] ?? DEFAULT_TRACE_DIR,
    help,
  };
}

export type RunnerIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Injected by tests; defaults to global fetch. */
  fetch?: FetchLike;
};

function buildProvider(args: RunnerArgs, env: Record<string, string | undefined>, io: RunnerIo): StrategyProvider {
  switch (args.provider) {
    case "scripted":
      return new ScriptedProvider(
        args.script === undefined
          ? SCRIPTED_NO_ACTION
          : readJsonFile(args.script, ProposalOutputSchema, "SCRIPT_INVALID"),
      );
    case "recorded": {
      if (args.recording === undefined) throw new Error("--recording <path> is required for --provider recorded");
      const provider = new RecordedProvider({ recordingPath: args.recording });
      io.stderr(
        `${RECORDED_LABEL}: replaying ${args.recording} (model ${provider.modelId}, recorded_at ${provider.recordedAt})\n`,
      );
      return provider;
    }
    case "anthropic": {
      const modelId = args.model ?? env.MODEL_ID ?? "";
      const apiKey = env.MODEL_API_KEY ?? "";
      if (modelId.length === 0) throw new Error("--model <id> or MODEL_ID is required for --provider anthropic");
      if (apiKey.length === 0) throw new Error("MODEL_API_KEY is required for --provider anthropic");
      return new AnthropicProvider({ apiKey, modelId, role: args.role, fetch: io.fetch });
    }
    case "agent-session": {
      if (args.proposal === undefined) throw new Error("--proposal <path> is required for --provider agent-session");
      return new AgentSessionProvider({ proposalPath: args.proposal });
    }
    case undefined:
      throw new Error(`--provider is required (${PROVIDERS.join(" | ")})`);
  }
}

/** Runs the CLI and returns the process exit code. Never prints the token or an API key. */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: RunnerIo,
): Promise<number> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (error) {
    io.stderr(`runner: ${errorMessage(error)}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    const token = args.token ?? env.MK_AGENT_TOKEN ?? "";
    if (token.length === 0) throw new Error("agent token missing: pass --token or set MK_AGENT_TOKEN");
    const client = new HttpKernelClient({ baseUrl: args.kernel, agentToken: token, fetch: io.fetch });

    if (args.contextOut !== undefined) {
      const context = contextFromKernel(await client.getContext());
      const contextHash = hashCanonical(context);
      const dump = {
        runner_version: RUNNER_VERSION,
        prompt_version: PROMPT_VERSION,
        role: args.role,
        role_statement: roleStatement(args.role),
        context_hash: contextHash,
        system_prompt: SYSTEM_PROMPT,
        user_message: renderUserMessage(context, args.role),
        context,
        proposal_file: {
          description:
            "Write this JSON file and run the runner with --provider agent-session --proposal <path>. raw_text must be the JSON object described by system_prompt; copy context_hash verbatim or the runner refuses the proposal as stale.",
          produced_by: "<session identifier, for example claude-code>",
          produced_at: "<ISO 8601 UTC timestamp>",
          context_hash: contextHash,
          raw_text: "<the JSON object>",
        },
      };
      await writeFile(args.contextOut, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
      io.stderr(`context written to ${args.contextOut} (context_hash ${contextHash}); nothing was proposed\n`);
      return 0;
    }

    const provider = buildProvider(args, env, io);
    const context =
      args.contextIn === undefined
        ? undefined
        : readJsonFile(args.contextIn, ContextDumpSchema, "CONTEXT_FILE_INVALID").context;
    const trace = await runOnce({
      client,
      provider,
      role: args.role,
      dryRun: args.dryRun,
      traceDir: args.traceDir,
      context,
    });
    io.stdout(`${JSON.stringify(trace, null, 2)}\n`);
    io.stderr(`trace written to ${tracePath(args.traceDir, trace)}\n`);
    return trace.output_kind === "NO_PROPOSAL" || trace.error !== undefined ? 2 : 0;
  } catch (error) {
    io.stderr(`runner: ${errorMessage(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((code) => {
    process.exitCode = code;
  });
}
