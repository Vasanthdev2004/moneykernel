import type { AuditEvent, IntentSize } from "./types.ts";

const EVENT_LABELS: Record<string, string> = {
  ACCOUNT_CREATED: "Account created",
  ACCOUNT_RESUMED: "Account resumed",
  ACCOUNT_PAUSED: "Account paused",
  ACCOUNT_STOPPED: "New orders stopped",
  AGENT_REGISTERED: "Agent registered",
  AGENT_QUARANTINED: "Agent quarantined",
  LEASE_ISSUED: "Spending lease issued",
  LEASE_REVOKED: "Lease revoked",
  POLICY_UPDATED: "Policy updated",
  INVENTORY_ASSIGNED: "Holdings assigned",
  INTENT_RECEIVED: "Trade request received",
  DECISION_RECORDED: "Request evaluated",
  RESERVATION_CREATED: "Funds reserved",
  RESERVATION_RELEASED: "Funds released",
  PROPOSAL_STATE_CHANGED: "Proposal updated",
  APPROVAL_CREATED: "Trade approved",
  APPROVAL_CONSUMED: "Approval consumed",
  COMMAND_CREATED: "Approved trade queued",
  COMMAND_ARMED: "Trade sent",
  COMMAND_OUTCOME: "Venue response received",
  ORDER_OBSERVED: "Order status updated",
  FILL_RECONCILED: "Fill reconciled",
  INCIDENT_RAISED: "Incident raised",
};

const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

/** Strips trailing zeros from a decimal string for display. Never rounds; non-decimal input is returned verbatim. */
export function trimDecimal(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!DECIMAL_RE.test(text) || !text.includes(".")) return text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" || trimmed === "-0" || trimmed === "+" ? "0" : trimmed;
}

export function amount(value: string | number | null | undefined, unit?: string | null): string {
  const text = trimDecimal(value);
  return unit ? `${text} ${unit}` : text;
}

export function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC wall-clock rendering with a trailing Z; the raw ISO string stays available as a title. */
export function fmtTs(iso: string | null | undefined): string {
  const t = parseIso(iso);
  if (t === null) return iso ? iso : "–";
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )}:${pad2(d.getUTCSeconds())}Z`;
}

export function fmtDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${pad2(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return `${hours}h ${pad2(restMinutes)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Age of a timestamp relative to the server clock. */
export function fmtAge(iso: string | null | undefined, serverNowMs: number): string {
  const t = parseIso(iso);
  if (t === null) return "–";
  const delta = serverNowMs - t;
  return delta < 0 ? `in ${fmtDuration(delta)}` : `${fmtDuration(delta)} ago`;
}

export interface Countdown {
  text: string;
  expired: boolean;
  urgent: boolean;
  remainingMs: number | null;
}

export function countdown(iso: string | null | undefined, serverNowMs: number): Countdown {
  const t = parseIso(iso);
  if (t === null) return { text: "–", expired: false, urgent: false, remainingMs: null };
  const remaining = t - serverNowMs;
  if (remaining <= 0) return { text: "expired", expired: true, urgent: false, remainingMs: remaining };
  return { text: fmtDuration(remaining), expired: false, urgent: remaining < 60_000, remainingMs: remaining };
}

export function shortHash(hash: string | null | undefined, length = 12): string {
  if (!hash) return "–";
  return hash.length <= length ? hash : `${hash.slice(0, length)}…`;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "–";
  return id.length <= 22 ? id : `${id.slice(0, 12)}…${id.slice(-6)}`;
}

export function describeSize(size: IntentSize | undefined): string {
  if (!size) return "–";
  return size.kind === "QUOTE_NOTIONAL"
    ? `${trimDecimal(size.amount)} ${size.quote_asset} (quote notional)`
    : `${trimDecimal(size.amount)} ${size.base_asset} (base quantity)`;
}

export function humanizeCode(value: string): string {
  const words = value.trim().toLowerCase().replaceAll("_", " ");
  return words.length === 0 ? "Unknown" : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? humanizeCode(type);
}

function eventText(event: AuditEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function reasonDescription(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case "SYMBOL_EXPOSURE_LIMIT":
      return "the portfolio concentration limit";
    case "ORDER_NOTIONAL_CAP":
      return "the maximum order size";
    case "LEASE_BUDGET":
      return "the agent's spending limit";
    case "QUOTE_AVAILABILITY":
      return "the available cash balance";
    case "OBSERVATION_FRESHNESS":
    case "STALE_MARKET_DATA":
      return "market data freshness requirements";
    case "SUBMISSION_LIMIT":
      return "the agent's submission limit";
    default:
      return humanizeCode(code).toLowerCase();
  }
}

/** Plain-language timeline copy. Raw event types and sequence numbers remain visible as audit metadata. */
export function describeEvent(event: AuditEvent): string {
  const state = eventText(event, "state") ?? eventText(event, "status");
  const from = eventText(event, "from");
  const to = eventText(event, "to");
  const outcome = eventText(event, "outcome");
  const reasonCodes = event.payload.reason_codes;
  const reasonCode =
    typeof reasonCodes === "string"
      ? reasonCodes
      : Array.isArray(reasonCodes) && typeof reasonCodes[0] === "string"
        ? reasonCodes[0]
        : null;
  switch (event.type) {
    case "ACCOUNT_CREATED":
      return `The account was created${state ? ` in ${humanizeCode(state).toLowerCase()} state` : ""}.`;
    case "ACCOUNT_RESUMED":
      return "Safety checks passed and new orders are allowed again.";
    case "ACCOUNT_PAUSED":
    case "ACCOUNT_STOPPED":
      return "New orders are paused until an operator resumes the account.";
    case "POLICY_UPDATED":
      return `Safety policy${event.payload.version !== undefined ? ` version ${String(event.payload.version)}` : ""} became active.`;
    case "AGENT_REGISTERED":
      return "A trading agent was added to this account.";
    case "AGENT_QUARANTINED":
      return "An agent was blocked from submitting new requests pending review.";
    case "LEASE_ISSUED":
      return "An agent received bounded spending authority.";
    case "LEASE_REVOKED":
      return "An agent's spending authority was removed.";
    case "INVENTORY_ASSIGNED":
      return "The account's starting virtual holdings were recorded.";
    case "INTENT_RECEIVED":
      return "An agent submitted a trade request for policy review.";
    case "DECISION_RECORDED": {
      const reason = reasonDescription(reasonCode);
      if (outcome === "ALLOW_PROPOSAL") return "The request passed policy without changes.";
      if (outcome === "COUNTERPROPOSE")
        return `MoneyKernel adjusted the request${reason ? ` to stay within ${reason}` : " to stay within policy"}.`;
      if (outcome === "DENY") return `MoneyKernel denied the request${reason ? ` because of ${reason}` : ""}.`;
      if (outcome === "HOLD") return `MoneyKernel held the request${reason ? ` for ${reason}` : " for review"}.`;
      return "MoneyKernel recorded its policy decision.";
    }
    case "RESERVATION_CREATED":
      return "Funds and a submission attempt were reserved while the request awaited a decision.";
    case "RESERVATION_RELEASED":
      return "Reserved funds were returned after the proposal expired or closed.";
    case "PROPOSAL_STATE_CHANGED":
      return from && to
        ? `Moved from ${humanizeCode(from).toLowerCase()} to ${humanizeCode(to).toLowerCase()}.`
        : `Proposal is now ${humanizeCode(to ?? state ?? "updated").toLowerCase()}.`;
    case "APPROVAL_CREATED":
      return "An operator approved the exact proposed order.";
    case "APPROVAL_CONSUMED":
      return "The approval was used to arm the matching order.";
    case "COMMAND_CREATED":
      return "The approved trade entered the execution queue.";
    case "COMMAND_ARMED":
      return "The exact approved order was durably armed for submission.";
    case "COMMAND_OUTCOME":
      return `The venue reported ${humanizeCode(outcome ?? state ?? "an outcome").toLowerCase()}.`;
    case "ORDER_OBSERVED":
      return `The latest order status is ${humanizeCode(state ?? "updated").toLowerCase()}.`;
    case "FILL_RECONCILED":
      return "A verified fill was applied to holdings and the ledger.";
    case "INCIDENT_RAISED":
      return "MoneyKernel found an issue that needs operator attention.";
    default:
      return "Recorded in the account audit log.";
  }
}

/** Base asset label for a symbol when only the quote asset is known (BTCUSDT + USDT -> BTC). */
export function baseAssetOf(symbol: string, quoteAsset: string | undefined): string {
  if (quoteAsset && symbol.endsWith(quoteAsset) && symbol.length > quoteAsset.length) {
    return symbol.slice(0, symbol.length - quoteAsset.length);
  }
  return "base";
}

const SUMMARY_KEYS = [
  "proposal_id",
  "intent_id",
  "command_id",
  "conflict_id",
  "incident_id",
  "agent_id",
  "lease_id",
  "client_order_id",
  "outcome",
  "state",
  "from",
  "to",
  "status",
  "severity",
  "type",
  "reason",
  "reason_codes",
  "symbol",
  "side",
  "asset",
  "amount",
  "quantity",
  "notional_quote",
  "signed_delta",
  "acquisition_budget_quote",
  "epoch",
  "version",
  "detail",
] as const;

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 28 ? `${value.slice(0, 20)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.filter((v) => typeof v === "string" || typeof v === "number").map(String);
    return items.length === 0 ? null : items.slice(0, 4).join(",");
  }
  return null;
}

/** Compact one-line summary from well-known payload keys; falls back to the first scalar keys. */
export function summarizeEvent(event: AuditEvent): string {
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const text = scalarText(event.payload[key]);
    if (text === null) continue;
    parts.push(`${key}=${text}`);
    if (parts.length >= 7) break;
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(event.payload)) {
      const text = scalarText(value);
      if (text === null) continue;
      parts.push(`${key}=${text}`);
      if (parts.length >= 5) break;
    }
  }
  return parts.join(" · ");
}

export interface EventRefs {
  intent_id: string | null;
  proposal_id: string | null;
  command_id: string | null;
}

export function eventRefs(event: AuditEvent): EventRefs {
  const str = (key: string): string | null => {
    const value = event.payload[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  return { intent_id: str("intent_id"), proposal_id: str("proposal_id"), command_id: str("command_id") };
}

/** Client-side download of a JSON document; the browser never rewrites the fetched content. */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key facts from an incident's evidence object, flattened one level for display. */
export function evidenceFacts(evidence: Record<string, unknown>): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(evidence)) {
    const text = scalarText(value);
    if (text !== null) facts.push([key, typeof value === "string" ? value : text]);
    else if (isRecord(value)) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        const innerText = scalarText(innerValue);
        if (innerText !== null)
          facts.push([`${key}.${innerKey}`, typeof innerValue === "string" ? innerValue : innerText]);
      }
    }
  }
  return facts;
}
