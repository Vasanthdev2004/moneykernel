import type { AuditEvent, IntentSize } from "./types.ts";

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
