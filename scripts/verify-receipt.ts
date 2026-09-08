/**
 * pnpm verify:receipt -- <export-file> (prd.md 22.2): offline verification of a
 * sanitized run export (prd.md 14.5, 23.4; T-54, T-55, T-58).
 *
 * Standalone by design: no database, no network, no kernel import. Only the
 * frozen contracts, the pure domain evaluator, and the local file system, so a
 * reviewer can verify an export on a fresh clone without any credential.
 *
 *   node scripts/verify-receipt.ts <export.json> [--checkpoint <hex64>] [--json]
 *
 * Exit codes: 0 every check passed; 1 at least one check failed; 2 unreadable or
 * invalid input (missing file, malformed JSON, export contract violation, bad
 * arguments). The report never echoes a matched secret-like value.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  canonicalJson,
  decisionFingerprint,
  type ExportedReceipt,
  HEX64_RE,
  type RunExport,
  RunExportSchema,
  verifyEventChain,
} from "@moneykernel/contracts";
import {
  abs,
  add,
  type Dec,
  dec,
  type EvaluationInput,
  type EvaluationResult,
  eq,
  evaluate,
  toDecimalString,
  ZERO,
} from "@moneykernel/domain";

export type VerificationCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** Number of items the check examined (events, receipts, commands, assets, patterns, ...). */
  count?: number;
};

export type VerificationSummary = {
  events: number;
  receipts: number;
  replayed: number;
  fingerprint_only: number;
  commands: number;
  fills: number;
};

export type VerificationReport = {
  ok: boolean;
  checks: VerificationCheck[];
  summary: VerificationSummary;
};

export type VerifyOptions = {
  /**
   * Trusted checkpoint retained out of band: the event_hash immediately
   * preceding the exported slice, or null for genesis. Undefined falls back to
   * the bundle's own checkpoint.previous_hash.
   */
  checkpointHash?: string | null;
};

export const CHECK_NAMES = [
  "schema",
  "event_chain",
  "receipt_fingerprints",
  "decision_replay",
  "receipt_linkage",
  "numerical_agreement",
  "ledger_conservation",
  "secret_scan",
  "sanitization",
] as const;

export const USAGE = `MoneyKernel receipt verifier (prd.md 22.2, 14.5, 23.4)

Usage: node scripts/verify-receipt.ts <export-file> [--checkpoint <hex64>] [--json]
       pnpm verify:receipt -- <export-file> [--checkpoint <hex64>] [--json]

  <export-file>          sanitized run export from GET /v1/runs/:id/export
  --checkpoint <hex64>   trusted event_hash preceding the exported slice, retained out of band (T-54);
                         default: the bundle's own checkpoint.previous_hash, normally genesis
  --json                 print the VerificationReport as JSON instead of the text report
  --help

Checks, in order: ${CHECK_NAMES.join(", ")}.
No database, network, or kernel code is used; only the contracts and the pure evaluator.

Exit codes: 0 every check passed; 1 at least one check failed; 2 unreadable or invalid input
(missing file, malformed JSON, export contract violation, bad arguments).
`;

type Row = Record<string, unknown>;

const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set(["FILLED", "CANCELED", "EXPIRED"]);
const FORBIDDEN_CONTEXT_KEYS: ReadonlySet<string> = new Set(["token", "secret", "api_key"]);
const MAX_LISTED = 3;
const MAX_MESSAGE = 120;

/**
 * Secret shapes (T-58). The first six are copied from scripts/doctor.ts, with the
 * assignment forms widened from `KEY = value` to the JSON `"KEY": "value"` this
 * scanner sees; the rest are the kernel's own credential shapes (prd.md 14.7).
 * The verifier never imports doctor: it must stay runnable without a database.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["anthropic key", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["binance-style key assignment", /BINANCE_[A-Z_]*(?:KEY|SECRET)"?\s*[:=]\s*['"]?[A-Za-z0-9]{32,}/],
  [
    "generic secret assignment",
    /(?:api[_-]?key|api[_-]?secret|access[_-]?token)"?\s*[:=]\s*['"][A-Za-z0-9_-]{24,}['"]/i,
  ],
  ["agent or operator bearer token", /\bmk[ao]_[A-Za-z0-9_-]{20,}\b/],
  ["bootstrap secret value", /bootstrap_secret"?\s*[:=]\s*['"]?[^'",\s{}]{8,}/i],
  ["token_hash key", /"token_hash"\s*:/],
];

// --- small helpers -----------------------------------------------------------

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

/** Strict decimal parse of an exported value; Postgres `numeric::text` forms canonicalize through dec(). */
function asDec(value: unknown): Dec | null {
  if (typeof value !== "string") return null;
  try {
    return dec(value);
  } catch {
    return null;
  }
}

/** Decimal sum of one field over rows, or null when any value is not a decimal string. */
function sumField(rows: ReadonlyArray<Row>, key: string): Dec | null {
  let total = ZERO;
  for (const row of rows) {
    const value = asDec(row[key]);
    if (value === null) return null;
    total = add(total, value);
  }
  return total;
}

function sameDecimal(left: unknown, right: unknown): boolean {
  const a = asDec(left);
  const b = asDec(right);
  return a !== null && b !== null && eq(a, b);
}

function show(value: Dec): string {
  try {
    return toDecimalString(value);
  } catch {
    return value.toFixed();
  }
}

/** Deep structural equality through the canonical JSON form; unserializable values never compare equal. */
function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function groupBy(rows: ReadonlyArray<Row>, key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const value = asString(row[key]);
    if (value === null) continue;
    const list = groups.get(value);
    if (list === undefined) groups.set(value, [row]);
    else list.push(row);
  }
  return groups;
}

function idSet(rows: ReadonlyArray<Row>): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = asString(row.id);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** At most MAX_LISTED items, each clipped, so a report line stays readable and never dumps a whole row. */
function listSome(items: ReadonlyArray<string>, maxLength = 160): string {
  const shown = items
    .slice(0, MAX_LISTED)
    .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength - 3)}...` : item));
  const more = items.length > MAX_LISTED ? `, +${items.length - MAX_LISTED} more` : "";
  return `${shown.join(", ")}${more}`;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "$";
  return `$${path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text;
}

/** True when any nested plain object carries one of the keys (compared case-insensitively). */
function containsKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, keys));
  const row = asRow(value);
  if (row === null) return false;
  for (const [key, item] of Object.entries(row)) {
    if (keys.has(key.toLowerCase()) || containsKey(item, keys)) return true;
  }
  return false;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// --- checks --------------------------------------------------------------------

function checkEventChain(run: RunExport, options: VerifyOptions): VerificationCheck {
  const supplied = options.checkpointHash !== undefined;
  const checkpointHash: string | null =
    options.checkpointHash === undefined ? run.checkpoint.previous_hash : options.checkpointHash;
  let source: string;
  if (checkpointHash === null) source = supplied ? "genesis (supplied)" : "genesis per the bundle checkpoint";
  else source = supplied ? "the supplied checkpoint" : "the bundle checkpoint";
  const chain = verifyEventChain(run.audit_events, checkpointHash);
  const events = run.audit_events.length;
  const countOk = events === run.checkpoint.event_count;
  let detail: string;
  if (!chain.ok) {
    detail = `first_bad_seq=${chain.first_bad_seq} reason=${chain.reason} (${plural(events, "event")} verified from ${source})`;
  } else if (!countOk) {
    detail = `${plural(events, "event")} exported but checkpoint.event_count=${run.checkpoint.event_count}`;
  } else {
    detail = `${plural(events, "event")} chain from ${source}; count matches checkpoint.event_count`;
  }
  return { name: "event_chain", ok: chain.ok && countOk, detail, count: events };
}

function checkFingerprints(run: RunExport): VerificationCheck {
  const failures: string[] = [];
  for (const receipt of run.receipts) {
    let recomputed: string | null;
    try {
      recomputed = decisionFingerprint({
        engine_version: receipt.engine_version,
        normalized_request: receipt.normalized_request,
        input_refs: receipt.input_refs,
        outcome: receipt.outcome,
        reason_codes: receipt.reason_codes,
        checks: receipt.checks,
        evaluated_at: receipt.evaluated_at,
      });
    } catch {
      recomputed = null;
    }
    if (recomputed !== receipt.decision_fingerprint) failures.push(receipt.decision_id);
  }
  const total = run.receipts.length;
  return {
    name: "receipt_fingerprints",
    ok: failures.length === 0,
    count: total,
    detail:
      failures.length === 0
        ? `${plural(total, "receipt")} recompute from engine_version, normalized_request, input_refs, outcome, reason_codes, checks, evaluated_at`
        : `${failures.length} of ${plural(total, "receipt")} do not recompute from their material: ${listSome(failures)}`,
  };
}

/** Pure replay of the archived logical context (prd.md 14.5, T-55). Never creates commands or touches a venue. */
function replayProblem(receipt: ExportedReceipt, proposalsById: ReadonlyMap<string, Row>): string | null {
  let result: EvaluationResult;
  try {
    result = evaluate(receipt.evaluation_input as EvaluationInput);
  } catch (error) {
    return `evaluator threw ${errorText(error)}`;
  }
  if (result.outcome !== receipt.outcome) return `outcome ${result.outcome} != recorded ${receipt.outcome}`;
  if (!sameCanonical(result.reason_codes, receipt.reason_codes)) return "reason_codes differ";
  if (!sameCanonical(result.checks, receipt.checks)) return "checks differ";
  if (!sameCanonical(result.normalized_request, receipt.normalized_request)) return "normalized_request differs";
  const proposal = receipt.proposal_id === null ? undefined : proposalsById.get(receipt.proposal_id);
  const recorded = proposal?.normalized_order ?? null;
  if (result.candidate === null && recorded === null) return null;
  if (!sameCanonical(result.candidate, recorded)) return "candidate differs from the proposal's normalized_order";
  return null;
}

function checkReplay(
  run: RunExport,
  proposalsById: ReadonlyMap<string, Row>,
): { check: VerificationCheck; replayed: number; fingerprintOnly: number } {
  let replayed = 0;
  let fingerprintOnly = 0;
  const failures: string[] = [];
  for (const receipt of run.receipts) {
    if (receipt.evaluation_input === null) {
      fingerprintOnly += 1;
      continue;
    }
    replayed += 1;
    const problem = replayProblem(receipt, proposalsById);
    if (problem !== null) failures.push(`${receipt.decision_id} (${problem})`);
  }
  const archived = `${fingerprintOnly} fingerprint-only: context not archived (receipt predates migration 0005)`;
  return {
    replayed,
    fingerprintOnly,
    check: {
      name: "decision_replay",
      ok: failures.length === 0,
      count: replayed,
      detail:
        failures.length === 0
          ? `${replayed} replayed through the pure evaluator with identical outcome, reason codes, checks, request, and candidate; ${archived}`
          : `${failures.length} of ${replayed} replays diverge: ${listSome(failures)}; ${archived}`,
    },
  };
}

function checkLinkage(run: RunExport): VerificationCheck {
  const intents = idSet(run.intents);
  const proposals = idSet(run.proposals);
  const approvals = idSet(run.approvals);
  const commands = idSet(run.commands);
  const orders = idSet(run.orders);
  const fills = idSet(run.fills);
  const dangling: string[] = [];
  let references = 0;
  const link = (kind: string, id: unknown, refName: string, ref: unknown, known: Set<string>, optional = false) => {
    if (optional && (ref === null || ref === undefined)) return;
    references += 1;
    if (typeof ref !== "string" || !known.has(ref)) dangling.push(`${kind} ${String(id)} -> ${refName} ${String(ref)}`);
  };
  for (const r of run.receipts) {
    link("receipt", r.decision_id, "intent", r.intent_id, intents);
    link("receipt", r.decision_id, "proposal", r.proposal_id, proposals, true);
  }
  for (const p of run.proposals) link("proposal", p.id, "intent", p.intent_id, intents);
  for (const a of run.approvals) link("approval", a.id, "proposal", a.proposal_id, proposals);
  for (const c of run.commands) {
    link("command", c.id, "proposal", c.proposal_id, proposals);
    link("command", c.id, "approval", c.approval_id, approvals);
  }
  for (const o of run.orders) link("order", o.id, "command", o.command_id, commands);
  for (const f of run.fills) link("fill", f.id, "order", f.order_id, orders);
  for (const l of run.ledger_entries) link("ledger_entry", l.id, "fill", l.source_fill_id, fills, true);
  for (const r of run.reservations) link("reservation", r.id, "proposal", r.proposal_id, proposals);
  return {
    name: "receipt_linkage",
    ok: dangling.length === 0,
    count: references,
    detail:
      dangling.length === 0
        ? `${plural(references, "reference")} between receipts, intents, proposals, approvals, commands, orders, fills, ledger, and reservations resolve`
        : `${plural(dangling.length, "dangling reference")}: ${listSome(dangling)}`,
  };
}

type AgreementContext = {
  proposalsById: ReadonlyMap<string, Row>;
  ordersByCommand: ReadonlyMap<string, Row[]>;
  fillsByOrder: ReadonlyMap<string, Row[]>;
  reservationsByProposal: ReadonlyMap<string, Row[]>;
  quoteAsset: string;
};

/** The BASE hold names the asset the kernel settled; fall back to the symbol without its quote suffix. */
function baseAssetFor(reservations: ReadonlyArray<Row>, symbol: unknown, quoteAsset: string): string | null {
  const hold = reservations.find((r) => r.kind === "BASE");
  const held = asString(hold?.asset);
  if (held !== null) return held;
  const text = asString(symbol);
  if (text !== null && text.length > quoteAsset.length && text.endsWith(quoteAsset)) {
    return text.slice(0, -quoteAsset.length);
  }
  return null;
}

/** prd.md 23.4: the normalized candidate, approval, reservation, and resulting order/fills agree numerically. */
function commandProblem(command: Row, ctx: AgreementContext): string | null {
  const proposalId = asString(command.proposal_id);
  const proposal = proposalId === null ? undefined : ctx.proposalsById.get(proposalId);
  if (proposalId === null || proposal === undefined) return "proposal not in export";
  const candidate = asRow(proposal.normalized_order);
  if (candidate === null) return "proposal has no normalized_order";
  const payload = asRow(command.exact_payload);
  if (payload === null) return "exact_payload is not an object";
  for (const key of ["quantity", "limit_price"] as const) {
    if (!sameDecimal(payload[key], candidate[key])) return `exact_payload.${key} differs from the approved candidate`;
  }
  const orders = ctx.ordersByCommand.get(asString(command.id) ?? "") ?? [];
  const order = orders[0];
  if (order === undefined || orders.length !== 1) return `${plural(orders.length, "order row")} (expected exactly 1)`;
  const fills = ctx.fillsByOrder.get(asString(order.id) ?? "") ?? [];
  const baseSum = sumField(fills, "base_qty");
  const quoteSum = sumField(fills, "quote_qty");
  const executedBase = asDec(order.executed_base);
  const executedQuote = asDec(order.executed_quote);
  if (baseSum === null || quoteSum === null || executedBase === null || executedQuote === null) {
    return "order or fill quantities are not decimal strings";
  }
  if (!eq(executedBase, baseSum)) return `order executed_base ${show(executedBase)} != fills ${show(baseSum)}`;
  if (!eq(executedQuote, quoteSum)) return `order executed_quote ${show(executedQuote)} != fills ${show(quoteSum)}`;
  const status = asString(order.status) ?? "?";
  if (!TERMINAL_ORDER_STATUSES.has(status)) return `order status ${status} is not terminal`;
  const reservations = ctx.reservationsByProposal.get(proposalId) ?? [];
  const open = reservations.filter((r) => r.state === "HELD" || r.state === "ARMED").length;
  if (open > 0) return `${plural(open, "reservation")} still HELD or ARMED after reconciliation`;
  const side = asString(candidate.side);
  if (side !== "BUY" && side !== "SELL") return "candidate side is not BUY or SELL";
  const kind = side === "BUY" ? "QUOTE" : "BASE";
  const settledAsset = side === "BUY" ? ctx.quoteAsset : baseAssetFor(reservations, order.symbol, ctx.quoteAsset);
  if (settledAsset === null) return "cannot determine the base asset for the SELL";
  const consumed = sumField(
    reservations.filter((r) => r.kind === kind && r.state === "CONSUMED"),
    "amount",
  );
  const commissions = sumField(
    fills.filter((f) => f.commission_asset === settledAsset),
    "commission_qty",
  );
  if (consumed === null || commissions === null) return "reservation amounts or commissions are not decimal strings";
  const executed = add(side === "BUY" ? quoteSum : baseSum, commissions);
  if (!eq(consumed, executed)) {
    return `CONSUMED ${kind} holds ${show(consumed)} != executed ${show(executed)} (fills plus ${settledAsset} commissions)`;
  }
  return null;
}

/** Every fill is journaled exactly once: one FILL_BASE, one FILL_QUOTE, at most one FILL_FEE (prd.md 14.3, T-39). */
function fillLedgerProblem(fill: Row, entries: ReadonlyArray<Row>): string | null {
  const byCategory = (category: string): Row[] => entries.filter((e) => e.category === category);
  const base = byCategory("FILL_BASE");
  const quote = byCategory("FILL_QUOTE");
  const fee = byCategory("FILL_FEE");
  if (base.length !== 1 || quote.length !== 1) {
    return `${base.length} FILL_BASE and ${quote.length} FILL_QUOTE ledger entries (expected exactly one each)`;
  }
  if (fee.length > 1) return `${fee.length} FILL_FEE ledger entries (expected at most one)`;
  const expectations: ReadonlyArray<readonly [category: string, entry: Row | undefined, field: string]> = [
    ["FILL_BASE", base[0], "base_qty"],
    ["FILL_QUOTE", quote[0], "quote_qty"],
    ["FILL_FEE", fee[0], "commission_qty"],
  ];
  for (const [category, entry, field] of expectations) {
    if (entry === undefined) continue;
    const delta = asDec(entry.signed_delta);
    const wanted = asDec(fill[field]);
    if (delta === null || wanted === null || !eq(abs(delta), wanted)) {
      return `${category} |signed_delta| != fill ${field}`;
    }
  }
  return null;
}

function checkNumericalAgreement(run: RunExport, proposalsById: ReadonlyMap<string, Row>): VerificationCheck {
  const ctx: AgreementContext = {
    proposalsById,
    ordersByCommand: groupBy(run.orders, "command_id"),
    fillsByOrder: groupBy(run.fills, "order_id"),
    reservationsByProposal: groupBy(run.reservations, "proposal_id"),
    quoteAsset: run.account.quote_asset,
  };
  const ledgerByFill = groupBy(run.ledger_entries, "source_fill_id");
  const reconciled = run.commands.filter(
    (c) => c.state === "ACCEPTED" && c.reconciled_at !== null && c.reconciled_at !== undefined,
  );
  const failures: string[] = [];
  for (const command of reconciled) {
    const problem = commandProblem(command, ctx);
    if (problem !== null) failures.push(`command ${String(command.id)}: ${problem}`);
  }
  for (const fill of run.fills) {
    const fillId = asString(fill.id) ?? "";
    const problem = fillLedgerProblem(fill, ledgerByFill.get(fillId) ?? []);
    if (problem !== null) failures.push(`fill ${String(fill.id)}: ${problem}`);
  }
  return {
    name: "numerical_agreement",
    ok: failures.length === 0,
    count: reconciled.length,
    detail:
      failures.length === 0
        ? `${plural(reconciled.length, "reconciled command")} and ${plural(run.fills.length, "fill")} agree: payload = candidate, order = fills, consumed holds = executed + commissions, ledger = fills`
        : `${plural(failures.length, "disagreement")}: ${listSome(failures)}`,
  };
}

/** prd.md 14.3: the ledger explains every balance, and attribution never changes account totals. */
function checkLedgerConservation(run: RunExport): VerificationCheck {
  const assets = new Set<string>();
  for (const rows of [run.ledger_entries, run.balances, run.allocations]) {
    for (const row of rows) {
      const asset = asString(row.asset);
      if (asset !== null) assets.add(asset);
    }
  }
  const failures: string[] = [];
  for (const asset of [...assets].sort()) {
    const ledgerSum = sumField(
      run.ledger_entries.filter((e) => e.asset === asset),
      "signed_delta",
    );
    const balanceRows = run.balances.filter((b) => b.asset === asset);
    // No balance row means the account never held the asset, so the ledger must sum to zero for it.
    let owned: Dec | null = null;
    if (balanceRows.length === 0) owned = ZERO;
    else if (balanceRows.length === 1) owned = asDec(balanceRows[0]?.owned_quantity);
    const allocated = sumField(
      run.allocations.filter((a) => a.asset === asset),
      "owned_quantity",
    );
    if (ledgerSum === null || owned === null || allocated === null) {
      failures.push(`${asset}: non-decimal amounts or duplicate balance rows`);
    } else if (!eq(ledgerSum, owned)) {
      failures.push(`${asset}: ledger sum ${show(ledgerSum)} != balance ${show(owned)}`);
    } else if (!eq(allocated, owned)) {
      failures.push(`${asset}: allocations ${show(allocated)} != balance ${show(owned)}`);
    }
  }
  return {
    name: "ledger_conservation",
    ok: failures.length === 0,
    count: assets.size,
    detail:
      failures.length === 0
        ? `${plural(assets.size, "asset")}: ledger entries sum to each balance and allocations sum to each balance`
        : `${plural(failures.length, "asset")} violate conservation: ${listSome(failures)}`,
  };
}

/** T-58: nothing credential-shaped anywhere in the file, and no agent row carries its token hash. Values are never printed. */
function checkSecrets(bundle: unknown, run: RunExport): VerificationCheck {
  let text: string;
  try {
    text = JSON.stringify(bundle) ?? "";
  } catch {
    return { name: "secret_scan", ok: false, detail: "export could not be serialized for scanning" };
  }
  const found = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const hashedAgents = run.agents.filter((agent) => Object.hasOwn(agent, "token_hash")).length;
  if (hashedAgents > 0) found.push(`token_hash present on ${plural(hashedAgents, "agent row")}`);
  return {
    name: "secret_scan",
    ok: found.length === 0,
    count: SECRET_PATTERNS.length,
    detail:
      found.length === 0
        ? `${SECRET_PATTERNS.length} patterns over ${text.length} chars: no secret-like values; agent rows carry no token_hash`
        : `secret-like content found (values withheld): ${found.join("; ")}`,
  };
}

function checkSanitization(run: RunExport): VerificationCheck {
  const executionMode = run.provenance.execution_mode;
  const accountEnvironment = run.account.environment;
  const modeOk = executionMode === run.environment && accountEnvironment === run.environment;
  const leaking = run.receipts
    .filter((r) => r.evaluation_input !== null && containsKey(r.evaluation_input, FORBIDDEN_CONTEXT_KEYS))
    .map((r) => r.decision_id);
  const problems: string[] = [];
  if (!modeOk) {
    problems.push(
      `provenance.execution_mode ${executionMode}, environment ${run.environment}, account.environment ${accountEnvironment} disagree`,
    );
  }
  if (leaking.length > 0) {
    problems.push(`${plural(leaking.length, "archived context")} with token/secret/api_key keys: ${listSome(leaking)}`);
  }
  return {
    name: "sanitization",
    ok: problems.length === 0,
    count: run.receipts.length,
    detail:
      problems.length === 0
        ? `execution_mode, environment, and account.environment all ${run.environment}; no archived context carries token, secret, or api_key keys`
        : problems.join("; "),
  };
}

// --- entry points ----------------------------------------------------------------

export function verifyRunExport(bundle: unknown, options: VerifyOptions = {}): VerificationReport {
  const parsed = RunExportSchema.safeParse(bundle);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined ? "export does not match RunExportSchema" : `${formatPath(issue.path)}: ${issue.message}`;
    return {
      ok: false,
      checks: [{ name: "schema", ok: false, detail: `${where}; remaining checks skipped` }],
      summary: { events: 0, receipts: 0, replayed: 0, fingerprint_only: 0, commands: 0, fills: 0 },
    };
  }
  const run = parsed.data;
  const proposalsById = new Map<string, Row>();
  for (const proposal of run.proposals) {
    const id = asString(proposal.id);
    if (id !== null) proposalsById.set(id, proposal);
  }
  const replay = checkReplay(run, proposalsById);
  const checks: VerificationCheck[] = [
    {
      name: "schema",
      ok: true,
      detail: `RunExportSchema ${run.schema_version}; engine ${run.engine_version}; ${run.environment} account ${run.account.id} epoch ${run.account.epoch}`,
    },
    checkEventChain(run, options),
    checkFingerprints(run),
    replay.check,
    checkLinkage(run),
    checkNumericalAgreement(run, proposalsById),
    checkLedgerConservation(run),
    checkSecrets(bundle, run),
    checkSanitization(run),
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    summary: {
      events: run.audit_events.length,
      receipts: run.receipts.length,
      replayed: replay.replayed,
      fingerprint_only: replay.fingerprintOnly,
      commands: run.commands.length,
      fills: run.fills.length,
    },
  };
}

export function formatReport(report: VerificationReport): string {
  const width = report.checks.reduce((max, check) => Math.max(max, check.name.length), 0);
  const lines = report.checks.map(
    (check) => `${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`,
  );
  const s = report.summary;
  lines.push(
    "",
    `summary: events=${s.events} receipts=${s.receipts} replayed=${s.replayed} fingerprint_only=${s.fingerprint_only} commands=${s.commands} fills=${s.fills}`,
    `verify:receipt: ${report.ok ? "passed" : "FAILED"}`,
  );
  return lines.join("\n");
}

const CLI_OPTIONS = {
  checkpoint: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

function parseCli(argv: ReadonlyArray<string>) {
  return parseArgs({ args: [...argv], options: CLI_OPTIONS, allowPositionals: true, strict: true });
}

/** CLI entry. Returns the process exit code; prints the report to stdout and problems to stderr. */
export function main(argv: ReadonlyArray<string>): number {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    console.error(`verify:receipt: ${errorText(error)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  const [file] = parsed.positionals;
  if (file === undefined || parsed.positionals.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const options: VerifyOptions = {};
  if (parsed.values.checkpoint !== undefined) {
    if (!HEX64_RE.test(parsed.values.checkpoint)) {
      console.error("verify:receipt: --checkpoint must be a 64-character lowercase sha256 hex digest");
      return 2;
    }
    options.checkpointHash = parsed.values.checkpoint;
  }
  let text: string;
  try {
    text = readFileSync(resolve(file), "utf8");
  } catch (error) {
    console.error(`verify:receipt: cannot read ${file}: ${errorText(error)}`);
    return 2;
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch {
    // The parser's message can quote file content; keep the report free of it.
    console.error(`verify:receipt: ${file} is not valid JSON`);
    return 2;
  }
  const report = verifyRunExport(bundle, options);
  console.log(parsed.values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  const schema = report.checks.find((check) => check.name === "schema");
  if (schema !== undefined && !schema.ok) return 2;
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
