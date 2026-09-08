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
  CandidateOrderSchema,
  canonicalJson,
  decisionFingerprint,
  type ExportedReceipt,
  exportSecretFindings,
  HEX64_RE,
  hashCanonical,
  type RunExport,
  RunExportSchema,
  verifyEventChain,
} from "@moneykernel/contracts";
import {
  add,
  type Dec,
  dec,
  ENGINE_VERSION,
  type EvaluationInput,
  type EvaluationResult,
  eq,
  evaluate,
  mul,
  toDecimalString,
  ZERO,
} from "@moneykernel/domain";
import { auditLinkageProblems } from "./verify-export-linkage.ts";

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
  /** Trusted final event hash retained out of band; unlike a predecessor, this binds the whole exported tail. */
  headCheckpointHash?: string;
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

Usage: node scripts/verify-receipt.ts <export-file> [--checkpoint <hex64>] [--head-checkpoint <hex64>] [--json]
       pnpm verify:receipt -- <export-file> [--checkpoint <hex64>] [--head-checkpoint <hex64>] [--json]

  <export-file>          sanitized run export from GET /v1/runs/:id/export
  --checkpoint <hex64>   trusted event_hash preceding the exported slice, retained out of band (T-54);
                         default: the bundle's own checkpoint.previous_hash, normally genesis
  --json                 print the VerificationReport as JSON instead of the text report
  --head-checkpoint <hex64> trusted final event_hash retained out of band; authenticates the exported tail
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
  const events = run.audit_events.length;
  const fail = (detail: string): VerificationCheck => ({ name: "event_chain", ok: false, detail, count: events });
  if (events === 0) return fail("account export has no audit evidence; no checkpoint can be verified");
  if (run.audit_events.some((event) => event.account_id !== run.account.id)) {
    return fail("audit event belongs to a different account");
  }
  if (new Set(run.audit_events.map((event) => event.id)).size !== events) return fail("duplicate audit event id");
  if (run.checkpoint.previous_hash === null && run.audit_events[0]?.account_seq !== 1) {
    return fail("genesis export must begin with account sequence 1");
  }
  let chain: ReturnType<typeof verifyEventChain>;
  try {
    chain = verifyEventChain(run.audit_events, checkpointHash);
  } catch {
    return fail("event payload is not valid canonical JSON");
  }
  const countOk = events === run.checkpoint.event_count;
  const tail = run.audit_events.at(-1);
  const headOk =
    (run.checkpoint.final_hash === undefined || run.checkpoint.final_hash === tail?.event_hash) &&
    (run.checkpoint.final_seq === undefined || run.checkpoint.final_seq === tail?.account_seq) &&
    (options.headCheckpointHash === undefined || options.headCheckpointHash === tail?.event_hash);
  let detail: string;
  if (!chain.ok) {
    detail = `first_bad_seq=${chain.first_bad_seq} reason=${chain.reason} (${plural(events, "event")} verified from ${source})`;
  } else if (!countOk) {
    detail = `${plural(events, "event")} exported but checkpoint.event_count=${run.checkpoint.event_count}`;
  } else if (!headOk) {
    detail = "exported tail does not match the declared or independently retained head checkpoint";
  } else {
    const trust =
      options.headCheckpointHash === undefined
        ? "unanchored internal consistency only; no independently retained final hash supplied"
        : "tail matches independently retained head checkpoint";
    detail = `${plural(events, "event")} chain from ${source}; count and declared head match; ${trust}`;
  }
  return { name: "event_chain", ok: chain.ok && countOk && headOk, detail, count: events };
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
  if (receipt.engine_version !== ENGINE_VERSION) return "archived engine version is unsupported by this evaluator";
  const input = asRow(receipt.evaluation_input);
  if (input === null || typeof input.now !== "string" || Date.parse(input.now) !== Date.parse(receipt.evaluated_at)) {
    return "evaluation time differs from the receipt";
  }
  let result: EvaluationResult;
  try {
    result = evaluate(receipt.evaluation_input as EvaluationInput);
  } catch {
    return "archived context cannot be evaluated";
  }
  if (result.outcome !== receipt.outcome) return `outcome ${result.outcome} != recorded ${receipt.outcome}`;
  if (!sameCanonical(result.reason_codes, receipt.reason_codes)) return "reason_codes differ";
  if (!sameCanonical(result.checks, receipt.checks)) return "checks differ";
  if (!sameCanonical(result.normalized_request, receipt.normalized_request)) return "normalized_request differs";
  if (!sameCanonical(result.input_refs, receipt.input_refs)) return "input_refs differ";
  const fingerprint = decisionFingerprint({
    engine_version: ENGINE_VERSION,
    normalized_request: result.normalized_request,
    input_refs: result.input_refs,
    outcome: result.outcome,
    reason_codes: result.reason_codes,
    checks: result.checks,
    evaluated_at: receipt.evaluated_at,
  });
  if (fingerprint !== receipt.decision_fingerprint) return "replayed decision fingerprint differs";
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
  if (run.engine_version !== ENGINE_VERSION) failures.push("export engine version is unsupported by this evaluator");
  for (const receipt of run.receipts) {
    if (receipt.evaluation_input === null) {
      fingerprintOnly += 1;
      continue;
    }
    replayed += 1;
    const problem = replayProblem(receipt, proposalsById);
    if (problem !== null) failures.push(`${receipt.decision_id} (${problem})`);
  }
  const archived = `${fingerprintOnly} fingerprint-only: context unavailable; replay completeness is not verified`;
  return {
    replayed,
    fingerprintOnly,
    check: {
      name: "decision_replay",
      ok: failures.length === 0,
      count: replayed,
      detail:
        failures.length === 0
          ? `${replayed} replayed through the pure evaluator with identical fingerprint, time, references, and candidate; ${archived}`
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
  const dangling: string[] = auditLinkageProblems(run);
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
  run: RunExport;
  proposalsById: ReadonlyMap<string, Row>;
  intentsById: ReadonlyMap<string, Row>;
  leasesById: ReadonlyMap<string, Row>;
  approvalsById: ReadonlyMap<string, Row>;
  policiesById: ReadonlyMap<string, Row>;
  commandsById: ReadonlyMap<string, Row>;
  commandsByProposal: ReadonlyMap<string, Row[]>;
  ordersById: ReadonlyMap<string, Row>;
  ordersByCommand: ReadonlyMap<string, Row[]>;
  fillsByOrder: ReadonlyMap<string, Row[]>;
  reservationsByProposal: ReadonlyMap<string, Row[]>;
  quoteAsset: string;
};

/** Asset identity comes from the approved symbol, never from a possibly misattributed hold. */
function baseAssetFor(symbol: unknown, quoteAsset: string): string | null {
  const text = asString(symbol);
  if (text !== null && text.length > quoteAsset.length && text.endsWith(quoteAsset)) {
    return text.slice(0, -quoteAsset.length);
  }
  return null;
}

const byId = (rows: ReadonlyArray<Row>): Map<string, Row> => new Map(rows.map((row) => [asString(row.id) ?? "", row]));
const hasTimestamp = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
const timeOf = (value: unknown): number => (typeof value === "string" ? Date.parse(value) : Number.NaN);
const isArmed = (command: Row): boolean => hasTimestamp(command.armed_at);
const isSettled = (command: Row): boolean => command.state === "ACCEPTED" && hasTimestamp(command.reconciled_at);
const isNonNegative = (value: unknown): boolean => asDec(value)?.gte(ZERO) === true;

function proposalProblem(proposal: Row, ctx: AgreementContext): string | null {
  const parsed = CandidateOrderSchema.safeParse(proposal.normalized_order);
  if (!parsed.success) return "invalid normalized_order";
  const candidate = parsed.data;
  const policy = ctx.policiesById.get(asString(proposal.policy_id) ?? "");
  if (policy === undefined) return "policy not in export";
  if (
    typeof proposal.intent_id !== "string" ||
    ![proposal.revision, policy.version, proposal.lease_revision, proposal.account_epoch].every(
      (value) => Number.isSafeInteger(value) && (value as number) >= 0,
    )
  )
    return "proposal authority identifiers or revisions are invalid";
  const expectedHash = hashCanonical({
    account_id: ctx.run.account.id,
    intent_id: proposal.intent_id,
    revision: proposal.revision,
    policy_version: policy.version,
    lease_revision: proposal.lease_revision,
    account_epoch: proposal.account_epoch,
    environment: ctx.run.environment,
    order: proposal.normalized_order,
  });
  if (proposal.proposal_hash !== expectedHash) return "proposal_hash does not bind the recorded order and authority";
  if (!eq(mul(dec(candidate.quantity), dec(candidate.limit_price)), dec(candidate.notional_quote))) {
    return "candidate notional_quote != quantity * limit_price";
  }
  if (candidate.side === "BUY") {
    if (
      !eq(dec(candidate.base_reserved), ZERO) ||
      !eq(dec(candidate.total_quote_reserved), add(dec(candidate.notional_quote), dec(candidate.fee_reserve_quote)))
    ) {
      return "BUY candidate resource envelope does not match notional plus fee";
    }
  } else if (
    !eq(dec(candidate.base_reserved), dec(candidate.quantity)) ||
    !eq(dec(candidate.total_quote_reserved), ZERO) ||
    !eq(dec(candidate.fee_reserve_quote), ZERO)
  ) {
    return "SELL candidate resource envelope does not match owned base quantity";
  }
  const intent = ctx.intentsById.get(asString(proposal.intent_id) ?? "");
  if (intent === undefined) return "intent not in export";
  const reservations = ctx.reservationsByProposal.get(asString(proposal.id) ?? "") ?? [];
  const kind = candidate.side === "BUY" ? "QUOTE" : "BASE";
  const asset = candidate.side === "BUY" ? ctx.quoteAsset : baseAssetFor(candidate.symbol, ctx.quoteAsset);
  if (asset === null) return "cannot determine approved base asset";
  const command = ctx.commandsByProposal.get(asString(proposal.id) ?? "")?.[0];
  const armed = command !== undefined && isArmed(command);
  const ended =
    command?.state === "ABORTED_PRE_ARM" || ["INVALIDATED", "REJECTED", "EXPIRED"].includes(String(proposal.state));
  const released = command?.state === "REJECTED_CONFIRMED";
  for (const r of reservations) {
    if (r.agent_id !== intent.agent_id) return "reservation owner differs from intent agent";
    if (!isNonNegative(r.amount)) return "reservation amount is not a nonnegative decimal";
    if (r.kind !== kind && r.kind !== "ATTEMPT") return "reservation kind differs from candidate resources";
    if (r.asset !== (r.kind === "ATTEMPT" ? "ATTEMPT" : asset)) return "reservation asset differs from approved asset";
    if (!["HELD", "ARMED", "CONSUMED", "RELEASED"].includes(String(r.state))) return "invalid reservation state";
    if (r.kind === "ATTEMPT") {
      if (r.state !== (armed ? "CONSUMED" : ended ? "RELEASED" : "HELD"))
        return "attempt hold state does not match arming";
    } else if (!armed) {
      if (r.state !== (ended ? "RELEASED" : "HELD")) return "never-armed financial hold has the wrong state";
    } else if (released) {
      if (r.state !== "RELEASED") return "confirmed rejection retains or consumes a financial hold";
    } else if (command !== undefined && isSettled(command)) {
      if (r.state === "HELD" || r.state === "ARMED") return "reservation still HELD or ARMED after reconciliation";
    } else if (r.state !== "ARMED" && r.state !== "CONSUMED") {
      return "unsettled command lost its financial hold before reconciliation";
    }
  }
  const financial = sumField(
    reservations.filter((r) => r.kind === kind),
    "amount",
  );
  const attempts = sumField(
    reservations.filter((r) => r.kind === "ATTEMPT"),
    "amount",
  );
  const envelope = dec(candidate.side === "BUY" ? candidate.total_quote_reserved : candidate.base_reserved);
  if (financial === null || !eq(financial, envelope)) return "total financial holds differ from the candidate envelope";
  if (reservations.filter((r) => r.kind === "ATTEMPT").length !== 1 || attempts === null || !eq(attempts, dec("1"))) {
    return "proposal must retain exactly one attempt hold";
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
  const expected = {
    environment: ctx.run.environment,
    account_id: ctx.run.account.id,
    client_order_id: command.client_order_id,
    symbol: candidate.symbol,
    side: candidate.side,
    order_type: candidate.order_type,
    proposal_hash: proposal.proposal_hash,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value !== "string" || payload[key] !== value)
      return `exact_payload.${key} differs from the approved binding`;
  }
  if (Object.keys(payload).length !== 9) return "exact_payload contains unapproved fields";
  const approval = ctx.approvalsById.get(asString(command.approval_id) ?? "");
  if (
    approval === undefined ||
    approval.proposal_id !== proposalId ||
    approval.proposal_revision !== proposal.revision ||
    approval.proposal_hash !== proposal.proposal_hash ||
    approval.account_epoch !== proposal.account_epoch
  ) {
    return "approval does not bind this proposal revision, hash, and epoch";
  }
  const armed = isArmed(command);
  const settled = isSettled(command);
  if (
    !["READY", "ARMED", "ACCEPTED", "REJECTED_CONFIRMED", "OUTCOME_UNKNOWN", "ABORTED_PRE_ARM"].includes(
      String(command.state),
    )
  ) {
    return "invalid command state";
  }
  const preArm = command.state === "READY" || command.state === "ABORTED_PRE_ARM";
  if (preArm === armed) return "command state contradicts armed_at";
  if (command.reconciled_at !== null && !settled) return "reconciled_at is invalid for command state";
  if (armed) {
    const intent = ctx.intentsById.get(asString(proposal.intent_id) ?? "");
    const lease = ctx.leasesById.get(asString(intent?.lease_id) ?? "");
    const capability = asRow(lease?.capability_json);
    if (
      intent === undefined ||
      lease === undefined ||
      intent.agent_id !== lease.agent_id ||
      !Number.isSafeInteger(lease.revision) ||
      !Number.isSafeInteger(proposal.lease_revision) ||
      Number(lease.revision) < Number(proposal.lease_revision) ||
      !(timeOf(lease.starts_at) <= timeOf(command.armed_at) && timeOf(command.armed_at) < timeOf(lease.expires_at))
    ) {
      return "command armed outside its owning lease authority";
    }
    for (const [key, value] of [
      ["allowed_symbols", candidate.symbol],
      ["allowed_sides", candidate.side],
      ["allowed_order_types", candidate.order_type],
    ]) {
      const allowed = capability?.[String(key)];
      if (!Array.isArray(allowed) || !allowed.includes(value)) return "command exceeds its lease capability";
    }
    if (proposal.state !== "COMMAND_CREATED") return "armed command proposal has been invalidated";
    if (approval.status !== "CONSUMED" || timeOf(approval.consumed_at) !== timeOf(command.armed_at)) {
      return "armed command requires its approval consumed at arm time";
    }
    if (
      !(
        timeOf(approval.created_at) <= timeOf(command.armed_at) &&
        timeOf(command.armed_at) < timeOf(approval.expires_at) &&
        timeOf(command.armed_at) < timeOf(proposal.expires_at)
      )
    )
      return "command armed outside approval/proposal validity";
    if (settled && timeOf(command.reconciled_at) < timeOf(command.armed_at)) return "reconciliation predates arming";
  } else if (
    approval.consumed_at !== null ||
    (command.state === "READY"
      ? approval.status !== "ACTIVE"
      : !["INVALIDATED", "EXPIRED"].includes(String(approval.status)))
  ) {
    return "never-armed command has inconsistent approval consumption/state";
  }
  const orders = ctx.ordersByCommand.get(asString(command.id) ?? "") ?? [];
  const order = orders[0];
  if (orders.length > 1 || (command.state === "ACCEPTED" && order === undefined)) {
    return `${plural(orders.length, "order row")} (expected exactly 1 for ACCEPTED)`;
  }
  if (order === undefined) {
    const consumed = (ctx.reservationsByProposal.get(proposalId) ?? []).some(
      (r) => r.kind !== "ATTEMPT" && r.state === "CONSUMED" && asDec(r.amount)?.gt(ZERO),
    );
    return consumed ? "financial holds consumed without an observed fill" : null;
  } // READY, ARMED, and ambiguous submissions need not have an observed order.
  if (preArm || command.state === "REJECTED_CONFIRMED") return "unsubmitted or rejected command has an order";
  if (order.symbol !== candidate.symbol || order.client_order_id !== command.client_order_id) {
    return "order identity differs from approved command";
  }
  const fills = ctx.fillsByOrder.get(asString(order.id) ?? "") ?? [];
  const baseSum = sumField(fills, "base_qty");
  const quoteSum = sumField(fills, "quote_qty");
  const executedBase = asDec(order.executed_base);
  const executedQuote = asDec(order.executed_quote);
  const quantity = asDec(candidate.quantity);
  const limit = asDec(candidate.limit_price);
  if (
    baseSum === null ||
    quoteSum === null ||
    executedBase === null ||
    executedQuote === null ||
    quantity === null ||
    limit === null
  ) {
    return "order or fill quantities are not decimal strings";
  }
  if (executedBase.lt(ZERO) || executedQuote.lt(ZERO) || executedBase.gt(quantity))
    return "order execution exceeds the approved quantity or is negative";
  if (executedBase.lt(baseSum) || (settled && !eq(executedBase, baseSum)))
    return `order executed_base ${show(executedBase)} != fills ${show(baseSum)}`;
  if (executedQuote.lt(quoteSum) || (settled && !eq(executedQuote, quoteSum)))
    return `order executed_quote ${show(executedQuote)} != fills ${show(quoteSum)}`;
  const limitNotional = mul(executedBase, limit);
  if (candidate.side === "BUY" ? executedQuote.gt(limitNotional) : executedQuote.lt(limitNotional))
    return "order execution violates the approved limit price";
  const status = asString(order.status) ?? "?";
  if (!["NEW", "PARTIALLY_FILLED", ...TERMINAL_ORDER_STATUSES].includes(status)) return "invalid order status";
  if (settled && !TERMINAL_ORDER_STATUSES.has(status)) return `order status ${status} is not terminal`;
  if (status === "FILLED" && !eq(executedBase, quantity)) return "FILLED order did not execute the approved quantity";
  const reservations = ctx.reservationsByProposal.get(proposalId) ?? [];
  const open = reservations.filter((r) => r.state === "HELD" || r.state === "ARMED").length;
  if (settled && open > 0) return `${plural(open, "reservation")} still HELD or ARMED after reconciliation`;
  const side = asString(candidate.side);
  if (side !== "BUY" && side !== "SELL") return "candidate side is not BUY or SELL";
  const kind = side === "BUY" ? "QUOTE" : "BASE";
  const settledAsset = side === "BUY" ? ctx.quoteAsset : baseAssetFor(candidate.symbol, ctx.quoteAsset);
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
  if (consumed.gt(executed) || (settled && !eq(consumed, executed))) {
    return `CONSUMED ${kind} holds ${show(consumed)} != executed ${show(executed)} (fills plus ${settledAsset} commissions)`;
  }
  return null;
}

/** Every known fill has correctly signed, attributed asset entries, including every positive fee. */
function fillLedgerProblem(fill: Row, entries: ReadonlyArray<Row>, ctx: AgreementContext): string | null {
  const order = ctx.ordersById.get(asString(fill.order_id) ?? "");
  const command = ctx.commandsById.get(asString(order?.command_id) ?? "");
  const proposal = ctx.proposalsById.get(asString(command?.proposal_id) ?? "");
  const candidate = asRow(proposal?.normalized_order);
  const intent = ctx.intentsById.get(asString(proposal?.intent_id) ?? "");
  if (order === undefined || command === undefined || candidate === null || intent === undefined)
    return "fill authority chain is incomplete";
  if (fill.symbol !== candidate.symbol || order.symbol !== candidate.symbol)
    return "fill symbol differs from approved order";
  const baseAsset = baseAssetFor(candidate.symbol, ctx.quoteAsset);
  const baseQty = asDec(fill.base_qty);
  const quoteQty = asDec(fill.quote_qty);
  const price = asDec(fill.price);
  const commission = asDec(fill.commission_qty);
  const limit = asDec(candidate.limit_price);
  if (
    baseAsset === null ||
    baseQty === null ||
    quoteQty === null ||
    price === null ||
    commission === null ||
    limit === null ||
    typeof fill.commission_asset !== "string" ||
    fill.commission_asset.length === 0 ||
    !baseQty.gt(ZERO) ||
    !quoteQty.gt(ZERO) ||
    !price.gt(ZERO) ||
    commission.lt(ZERO)
  )
    return "fill has invalid financial values";
  if (!eq(mul(baseQty, price), quoteQty)) return "fill quote_qty != base_qty * price";
  if (candidate.side !== "BUY" && candidate.side !== "SELL") return "invalid fill side";
  if (candidate.side === "BUY" ? price.gt(limit) : price.lt(limit)) return "fill price violates the approved limit";
  const byCategory = (category: string): Row[] => entries.filter((e) => e.category === category);
  const base = byCategory("FILL_BASE");
  const quote = byCategory("FILL_QUOTE");
  const fee = byCategory("FILL_FEE");
  if (base.length !== 1 || quote.length !== 1) {
    return `${base.length} FILL_BASE and ${quote.length} FILL_QUOTE ledger entries (expected exactly one each)`;
  }
  const feeCount = commission.gt(ZERO) ? 1 : 0;
  if (fee.length !== feeCount)
    return `${fee.length} FILL_FEE ledger entries (expected ${feeCount} for recorded commission)`;
  if (entries.length !== 2 + feeCount) return "fill has extra ledger categories";
  const buy = candidate.side === "BUY";
  const expectations: ReadonlyArray<readonly [category: string, entry: Row | undefined, asset: unknown, delta: Dec]> = [
    ["FILL_BASE", base[0], baseAsset, buy ? baseQty : baseQty.negated()],
    ["FILL_QUOTE", quote[0], ctx.quoteAsset, buy ? quoteQty.negated() : quoteQty],
    ["FILL_FEE", fee[0], fill.commission_asset, commission.negated()],
  ];
  for (const [category, entry, asset, wanted] of expectations) {
    if (entry === undefined) continue;
    const delta = asDec(entry.signed_delta);
    if (delta === null || !eq(delta, wanted)) return `${category} signed_delta differs from the fill debit/credit`;
    if (entry.asset !== asset || entry.agent_id !== intent.agent_id || entry.source_ref !== fill.exchange_trade_id) {
      return `${category} asset, owner, or trade identity differs from fill`;
    }
  }
  return null;
}

function checkNumericalAgreement(run: RunExport, proposalsById: ReadonlyMap<string, Row>): VerificationCheck {
  const ctx: AgreementContext = {
    run,
    proposalsById,
    intentsById: byId(run.intents),
    leasesById: byId(run.leases),
    approvalsById: byId(run.approvals),
    policiesById: byId(run.policy_versions),
    commandsById: byId(run.commands),
    commandsByProposal: groupBy(run.commands, "proposal_id"),
    ordersById: byId(run.orders),
    ordersByCommand: groupBy(run.orders, "command_id"),
    fillsByOrder: groupBy(run.fills, "order_id"),
    reservationsByProposal: groupBy(run.reservations, "proposal_id"),
    quoteAsset: run.account.quote_asset,
  };
  const ledgerByFill = groupBy(run.ledger_entries, "source_fill_id");
  const reconciled = run.commands.filter(isSettled);
  const failures: string[] = [];
  for (const proposal of run.proposals) {
    const problem = proposalProblem(proposal, ctx);
    if (problem !== null) failures.push(`proposal ${String(proposal.id)}: ${problem}`);
  }
  for (const command of run.commands) {
    const problem = commandProblem(command, ctx);
    if (problem !== null) failures.push(`command ${String(command.id)}: ${problem}`);
  }
  for (const fill of run.fills) {
    const fillId = asString(fill.id) ?? "";
    const problem = fillLedgerProblem(fill, ledgerByFill.get(fillId) ?? [], ctx);
    if (problem !== null) failures.push(`fill ${String(fill.id)}: ${problem}`);
  }
  for (const lease of run.leases) {
    let consumed = ZERO;
    let attempts = 0;
    let reserved = ZERO;
    let reservedAttempts = ZERO;
    for (const proposal of run.proposals) {
      const intent = ctx.intentsById.get(asString(proposal.intent_id) ?? "");
      if (intent === undefined || intent.lease_id !== lease.id) continue;
      if (intent.agent_id !== lease.agent_id)
        failures.push(`lease ${String(lease.id)}: intent agent differs from lease owner`);
      const holds = ctx.reservationsByProposal.get(asString(proposal.id) ?? "") ?? [];
      for (const hold of holds) {
        const amount = asDec(hold.amount);
        if (amount === null) continue; // proposal check reports malformed holds.
        if (hold.kind === "QUOTE" && (hold.state === "HELD" || hold.state === "ARMED"))
          reserved = add(reserved, amount);
        if (hold.kind === "ATTEMPT" && hold.state === "HELD") reservedAttempts = add(reservedAttempts, amount);
      }
      for (const command of ctx.commandsByProposal.get(asString(proposal.id) ?? "") ?? []) {
        if (isArmed(command)) attempts += 1;
        if (asRow(proposal.normalized_order)?.side !== "BUY") continue;
        for (const order of ctx.ordersByCommand.get(asString(command.id) ?? "") ?? []) {
          for (const fill of ctx.fillsByOrder.get(asString(order.id) ?? "") ?? []) {
            const quote = asDec(fill.quote_qty);
            const fee = fill.commission_asset === ctx.quoteAsset ? asDec(fill.commission_qty) : ZERO;
            if (quote !== null && fee !== null) consumed = add(consumed, add(quote, fee));
          }
        }
      }
    }
    const budget = asDec(lease.budget_quote);
    if (!sameDecimal(lease.consumed_quote, show(consumed)))
      failures.push(`lease ${String(lease.id)}: consumed_quote differs from BUY fills plus quote fees`);
    if (budget === null || budget.lt(ZERO) || add(consumed, reserved).gt(budget))
      failures.push(`lease ${String(lease.id)}: budget does not cover consumed and reserved quote`);
    if (
      lease.attempts_consumed !== attempts ||
      !Number.isSafeInteger(lease.attempt_limit) ||
      dec(String(attempts)).plus(reservedAttempts).gt(String(lease.attempt_limit))
    ) {
      failures.push(`lease ${String(lease.id)}: attempts do not match armed commands and outstanding holds`);
    }
  }
  return {
    name: "numerical_agreement",
    ok: failures.length === 0,
    count: run.commands.length,
    detail:
      failures.length === 0
        ? `${plural(reconciled.length, "reconciled command")}, ${plural(run.commands.length - reconciled.length, "command without completed settlement")}, and ${plural(run.fills.length, "fill")}: approval/payload, resources, known fills, and ledger agree; only reconciled commands have complete settlement proof`
        : `${plural(failures.length, "disagreement")}: ${listSome(failures)}`,
  };
}

/** Replay the supported attribution mutations: one virtual baseline, absolute assignments, and reconciled fills. */
function allocationProblems(run: RunExport): string[] {
  const failures: string[] = [];
  const expected = new Map<string, { owner: string; asset: string; amount: Dec }>();
  const balances = new Map<string, Dec>();
  const agents = idSet(run.agents);
  const fills = byId(run.fills);
  const orders = byId(run.orders);
  const commands = byId(run.commands);
  const proposals = byId(run.proposals);
  const intents = byId(run.intents);
  const seenFills = new Set<string>();
  let baselineSeen = false;
  const key = (owner: string, asset: string): string => JSON.stringify([owner, asset]);
  const set = (owner: unknown, asset: unknown, value: unknown): boolean => {
    const amount = asDec(value);
    if (
      typeof owner !== "string" ||
      (owner !== "UNASSIGNED" && !agents.has(owner)) ||
      typeof asset !== "string" ||
      asset.length === 0 ||
      amount === null ||
      amount.lt(ZERO)
    ) {
      failures.push("attribution event has an invalid owner, asset, or amount");
      return false;
    }
    if (asset === run.account.quote_asset && owner !== "UNASSIGNED" && amount.gt(ZERO)) {
      failures.push("shared quote cash must remain UNASSIGNED");
    }
    expected.set(key(owner, asset), { owner, asset, amount });
    return true;
  };
  const apply = (owner: string, asset: string, delta: Dec): void => {
    const entry = expected.get(key(owner, asset));
    const next = add(entry?.amount ?? ZERO, delta);
    if (next.lt(ZERO)) failures.push("recorded fills overdraw attributed inventory");
    expected.set(key(owner, asset), { owner, asset, amount: next });
    balances.set(asset, add(balances.get(asset) ?? ZERO, delta));
  };
  const conserved = (asset: string): void => {
    let attributed = ZERO;
    for (const entry of expected.values()) if (entry.asset === asset) attributed = add(attributed, entry.amount);
    if (!eq(attributed, balances.get(asset) ?? ZERO))
      failures.push("inventory assignment does not conserve account assets");
  };
  for (const event of run.audit_events) {
    const p = event.payload;
    if (event.type === "INVENTORY_ASSIGNED") {
      if (typeof p.baseline_ref === "string") {
        const owned = asRow(p.balances);
        const allocations = asRow(p.allocations);
        if (baselineSeen || seenFills.size > 0 || expected.size > 0 || owned === null || allocations === null) {
          failures.push("initial inventory baseline is missing, duplicated, or out of order");
          continue;
        }
        baselineSeen = true;
        const baseline = run.ledger_entries.filter((entry) => entry.category === "BASELINE");
        for (const [asset, value] of Object.entries(owned)) {
          const amount = asDec(value);
          const entries = baseline.filter((entry) => entry.asset === asset);
          const entry = entries[0];
          if (
            amount === null ||
            amount.lt(ZERO) ||
            entries.length !== 1 ||
            entry === undefined ||
            entry.source_ref !== p.baseline_ref ||
            entry.agent_id !== null ||
            entry.source_fill_id !== null ||
            !sameDecimal(entry.signed_delta, value)
          ) {
            failures.push("baseline ledger differs from recorded initial inventory");
            continue;
          }
          balances.set(asset, amount);
        }
        if (baseline.length !== Object.keys(owned).length) failures.push("baseline ledger has missing or extra assets");
        for (const [owner, values] of Object.entries(allocations)) {
          const assets = asRow(values);
          if (assets === null) {
            failures.push("invalid baseline allocations");
            continue;
          }
          for (const [asset, amount] of Object.entries(assets)) {
            if (!Object.hasOwn(owned, asset)) failures.push("baseline allocation has no owned asset");
            set(owner, asset, amount);
          }
        }
        for (const asset of balances.keys()) conserved(asset);
      } else if (Array.isArray(p.assignments)) {
        // POST /v1/inventory/assignments sets these owner/asset quantities; they are not deltas.
        const touched = new Set<string>();
        for (const value of p.assignments) {
          const assignment = asRow(value);
          if (assignment === null) {
            failures.push("invalid inventory assignment evidence");
            continue;
          }
          if (!set(assignment.owner, assignment.asset, assignment.quantity)) continue;
          touched.add(String(assignment.asset));
        }
        for (const asset of touched) conserved(asset);
      } else failures.push("unsupported inventory assignment evidence cannot establish attribution");
    } else if (event.type === "FILL_RECONCILED") {
      const fill = fills.get(asString(p.fill_id) ?? "");
      const order = orders.get(asString(fill?.order_id) ?? "");
      const command = commands.get(asString(order?.command_id) ?? "");
      const proposal = proposals.get(asString(command?.proposal_id) ?? "");
      const candidate = asRow(proposal?.normalized_order);
      const intent = intents.get(asString(proposal?.intent_id) ?? "");
      const baseAsset = baseAssetFor(candidate?.symbol, run.account.quote_asset);
      const base = asDec(fill?.base_qty);
      const quote = asDec(fill?.quote_qty);
      const fee = asDec(fill?.commission_qty);
      if (
        fill === undefined ||
        typeof fill.id !== "string" ||
        seenFills.has(fill.id) ||
        intent === undefined ||
        typeof intent.agent_id !== "string" ||
        baseAsset === null ||
        base === null ||
        quote === null ||
        fee === null ||
        (candidate?.side !== "BUY" && candidate?.side !== "SELL")
      ) {
        failures.push("fill attribution evidence is missing, duplicated, or invalid");
        continue;
      }
      seenFills.add(fill.id);
      if (fee.gt(ZERO) && fill.commission_asset !== baseAsset && fill.commission_asset !== run.account.quote_asset) {
        failures.push("unsupported fee asset prevents complete attribution proof");
        continue;
      }
      const baseDelta = (candidate.side === "BUY" ? base : base.negated()).minus(
        fill.commission_asset === baseAsset ? fee : ZERO,
      );
      const quoteDelta = (candidate.side === "BUY" ? quote.negated() : quote).minus(
        fill.commission_asset === run.account.quote_asset ? fee : ZERO,
      );
      if (
        (p.agent_id !== undefined && p.agent_id !== intent.agent_id) ||
        (p.agent_allocation_delta !== undefined && !sameDecimal(p.agent_allocation_delta, show(baseDelta))) ||
        (p.base_delta !== undefined && !sameDecimal(p.base_delta, show(baseDelta))) ||
        (p.quote_delta !== undefined && !sameDecimal(p.quote_delta, show(quoteDelta)))
      ) {
        failures.push("fill attribution event differs from its financial deltas and owner");
      }
      apply(intent.agent_id, baseAsset, baseDelta);
      apply("UNASSIGNED", run.account.quote_asset, quoteDelta);
    }
  }
  if (run.ledger_entries.some((entry) => entry.category === "BASELINE") && !baselineSeen)
    failures.push("initial allocation baseline evidence is missing");
  if (
    run.ledger_entries.some(
      (entry) => !["BASELINE", "FILL_BASE", "FILL_QUOTE", "FILL_FEE"].includes(String(entry.category)),
    )
  ) {
    failures.push("unsupported ledger correction requires attribution verification not provided by this engine");
  }
  if (seenFills.size !== run.fills.length) failures.push("not every fill has attribution evidence");
  for (const allocation of run.allocations) {
    const owner = asString(allocation.agent_or_unassigned_id) ?? "";
    const asset = asString(allocation.asset) ?? "";
    const amount = asDec(allocation.owned_quantity);
    if (asset === run.account.quote_asset && owner !== "UNASSIGNED" && amount?.gt(ZERO))
      failures.push("shared quote cash must remain UNASSIGNED");
    if (amount === null || !eq(amount, expected.get(key(owner, asset))?.amount ?? ZERO)) {
      failures.push("allocation differs from recorded baseline, assignments, and net fills");
    }
    expected.delete(key(owner, asset));
  }
  if ([...expected.values()].some((entry) => !eq(entry.amount, ZERO)))
    failures.push("recorded owner inventory is missing from allocations");
  return failures;
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
  const allocationKeys = new Set<string>();
  const agents = idSet(run.agents);
  for (const row of [...run.balances, ...run.allocations]) {
    if (asString(row.asset) === null || !isNonNegative(row.owned_quantity)) {
      failures.push("balance/allocation asset or nonnegative owned quantity is invalid");
    }
  }
  for (const allocation of run.allocations) {
    const owner = asString(allocation.agent_or_unassigned_id);
    const key = `${String(allocation.asset)}:${String(owner)}`;
    if (owner === null || (owner !== "UNASSIGNED" && !agents.has(owner)))
      failures.push("allocation owner is not a recorded agent or UNASSIGNED");
    if (allocationKeys.has(key)) failures.push("duplicate allocation for one asset and owner");
    allocationKeys.add(key);
  }
  const outstanding = run.reservations.filter(
    (r) => r.kind !== "ATTEMPT" && (r.state === "HELD" || r.state === "ARMED"),
  );
  for (const [asset, holds] of groupBy(outstanding, "asset")) {
    const held = sumField(holds, "amount");
    const owned = asDec(run.balances.find((b) => b.asset === asset)?.owned_quantity);
    if (held === null || owned === null || held.gt(owned))
      failures.push(`${asset}: outstanding holds exceed account inventory`);
    for (const [agentId, agentHolds] of groupBy(
      holds.filter((r) => r.kind === "BASE"),
      "agent_id",
    )) {
      const reservedBase = sumField(agentHolds, "amount");
      const allocatedBase = asDec(
        run.allocations.find((a) => a.asset === asset && a.agent_or_unassigned_id === agentId)?.owned_quantity,
      );
      if (reservedBase === null || allocatedBase === null || reservedBase.gt(allocatedBase))
        failures.push(`${asset}: outstanding SELL holds exceed their agent inventory`);
    }
  }
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
  failures.push(...allocationProblems(run));
  return {
    name: "ledger_conservation",
    ok: failures.length === 0,
    count: assets.size,
    detail:
      failures.length === 0
        ? `${plural(assets.size, "asset")}: ledger entries explain balances; allocations match baseline, assignments, net fills, and account totals`
        : `${plural(failures.length, "asset")} violate conservation: ${listSome(failures)}`,
  };
}

/** T-58: nothing credential-shaped anywhere in the file, and no agent row carries its token hash. Values are never printed. */
function checkSecrets(bundle: unknown): VerificationCheck {
  const found = exportSecretFindings(bundle);
  return {
    name: "secret_scan",
    ok: found.length === 0,
    detail:
      found.length === 0
        ? "shared export safety scan: no secret-like values or credential fields found"
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
    return {
      ok: false,
      checks: [
        { name: "schema", ok: false, detail: "export does not match RunExportSchema; remaining checks skipped" },
      ],
      summary: { events: 0, receipts: 0, replayed: 0, fingerprint_only: 0, commands: 0, fills: 0 },
    };
  }
  // Schema errors above are static; scan before any row check can echo untrusted identities.
  const secretScan = checkSecrets(bundle);
  if (!secretScan.ok) {
    return {
      ok: false,
      checks: [secretScan],
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
    secretScan,
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
  "head-checkpoint": { type: "string" },
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
  } catch {
    console.error(`verify:receipt: invalid command-line arguments\n\n${USAGE}`);
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
  if (parsed.values["head-checkpoint"] !== undefined) {
    if (!HEX64_RE.test(parsed.values["head-checkpoint"])) {
      console.error("verify:receipt: --head-checkpoint must be a 64-character lowercase sha256 hex digest");
      return 2;
    }
    options.headCheckpointHash = parsed.values["head-checkpoint"];
  }
  let text: string;
  try {
    text = readFileSync(resolve(file), "utf8");
  } catch {
    console.error("verify:receipt: cannot read export file");
    return 2;
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch {
    // The parser's message can quote file content; keep the report free of it.
    console.error("verify:receipt: export file is not valid JSON");
    return 2;
  }
  let report: VerificationReport;
  try {
    report = verifyRunExport(bundle, options);
  } catch {
    // No raw exception, stack, payload, or filename is safe to echo for untrusted input.
    report = {
      ok: false,
      checks: [{ name: "schema", ok: false, detail: "export contains invalid verification material" }],
      summary: { events: 0, receipts: 0, replayed: 0, fingerprint_only: 0, commands: 0, fills: 0 },
    };
  }
  console.log(parsed.values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  const schema = report.checks.find((check) => check.name === "schema");
  if (schema !== undefined && !schema.ok) return 2;
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
