import { fmtDuration } from "../format.ts";
import type { StreamStatus } from "../hooks.ts";
import { integrationState, modeBadge } from "../states.ts";
import type { IntegrationKey, StatusResponse } from "../types.ts";
import { Badge } from "./common.tsx";

const INTEGRATIONS: ReadonlyArray<[IntegrationKey, string, string]> = [
  ["agent_os_mcp", "MCP", "Agent OS MCP"],
  ["market_data", "MARKET", "Market data"],
  ["execution", "EXEC", "Execution"],
  ["model", "MODEL", "Model"],
];

export function TopBar({
  status,
  streamStatus,
  lastRefreshAt,
  now,
  refreshing,
  operatorId,
  stopInFlight,
  resumeInFlight,
  onRefresh,
  onStop,
  onResume,
  onLogout,
}: {
  status: StatusResponse | null;
  streamStatus: StreamStatus;
  lastRefreshAt: number | null;
  now: number;
  refreshing: boolean;
  operatorId: string;
  stopInFlight: boolean;
  resumeInFlight: boolean;
  onRefresh: () => void;
  onStop: () => void;
  onResume: () => void;
  onLogout: () => void;
}) {
  const mode = modeBadge(status?.mode ?? null);
  const accountStatus = status?.account.status ?? null;
  const stream =
    streamStatus === "live"
      ? { tone: "neutral" as const, glyph: "●", label: "live" }
      : streamStatus === "reconnecting"
        ? { tone: "amber" as const, glyph: "↻", label: "reconnecting" }
        : streamStatus === "loading"
          ? { tone: "muted" as const, glyph: "…", label: "loading events" }
          : { tone: "muted" as const, glyph: "○", label: "stream off" };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand">
          Money<span className="brand-accent">Kernel</span>
        </span>
        <Badge tone={mode.tone} glyph={mode.glyph} className="mode-badge" title="Execution mode and provenance">
          {mode.label}
        </Badge>
      </div>
      <section className="topbar-integrations" aria-label="Integration state">
        {INTEGRATIONS.map(([key, short, full]) => {
          const entry = status?.integration[key];
          const presentation = entry ? integrationState(entry.state) : null;
          return presentation ? (
            <Badge
              key={key}
              tone={presentation.tone}
              glyph={presentation.glyph}
              title={`${full}: ${entry?.detail ?? ""}`}
            >
              {short} · {presentation.label}
            </Badge>
          ) : (
            <Badge key={key} tone="muted" glyph="–" title={full}>
              {short} · unknown
            </Badge>
          );
        })}
      </section>
      <div className="topbar-controls">
        <span className="stream-indicator" title="Event stream">
          <Badge tone={stream.tone} glyph={stream.glyph}>
            {stream.label}
          </Badge>
        </span>
        <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
          {lastRefreshAt !== null && (
            <span className="muted small"> · {fmtDuration(Math.max(0, now - lastRefreshAt))} ago</span>
          )}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="stop-button"
          onClick={onStop}
          disabled={stopInFlight}
          aria-label="Stop new orders"
        >
          <span className="glyph" aria-hidden="true">
            ▮▮
          </span>{" "}
          {stopInFlight ? "STOPPING…" : "STOP NEW ORDERS"}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="resume-button"
          onClick={onResume}
          disabled={resumeInFlight || accountStatus === "READY"}
          title={accountStatus === "READY" ? "Account is already READY" : "Resume requires zero outstanding commands"}
        >
          {resumeInFlight ? "Resuming…" : "Resume"}
        </button>
        <span className="operator muted small" title="Operator session">
          {operatorId}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
