import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, Ellipsis, Layers, LogOut, Pause, Play, RefreshCw } from "lucide-react";
import { fmtDuration } from "../format.ts";
import type { StreamStatus } from "../hooks.ts";
import { modeBadge, accountStatus as presentAccountStatus } from "../states.ts";
import { ThemeToggle } from "../theme.tsx";
import type { StatusResponse } from "../types.ts";
import { Badge } from "./common.tsx";

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
  onExport,
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
  onExport: () => void;
  onStop: () => void;
  onResume: () => void;
  onLogout: () => void;
}) {
  const mode = modeBadge(status?.mode ?? null);
  const accountStatus = status?.account.status ?? null;
  const account = presentAccountStatus(accountStatus);
  const stream =
    streamStatus === "live"
      ? { tone: "neutral" as const, glyph: "●", label: "Live" }
      : streamStatus === "reconnecting"
        ? { tone: "amber" as const, glyph: "↻", label: "Reconnecting" }
        : streamStatus === "loading"
          ? { tone: "muted" as const, glyph: "…", label: "Loading events" }
          : { tone: "muted" as const, glyph: "○", label: "Stream off" };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">
          <Layers size={20} strokeWidth={1.8} />
        </span>
        <span className="brand">
          Money<span className="brand-accent">Kernel</span>
        </span>
        <Badge tone={mode.tone} glyph={mode.glyph} className="mode-badge" title="Execution mode and provenance">
          {mode.label}
        </Badge>
      </div>
      <div className="topbar-controls">
        <span className="stream-indicator" title="Event stream" aria-live="polite">
          <Badge tone={stream.tone} glyph={stream.glyph}>
            {stream.label}
          </Badge>
        </span>
        <Badge
          tone={account.tone}
          glyph={account.glyph}
          title={account.note ?? "Account status"}
          testId="account-status"
          className="topbar-account"
        >
          {account.label}
        </Badge>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="stop-button"
          onClick={onStop}
          disabled={stopInFlight}
          aria-label="Stop new orders"
        >
          <Pause size={15} aria-hidden="true" />
          {stopInFlight ? "Stopping…" : "Stop new orders"}
        </button>
        <button
          type="button"
          className="btn btn-ghost resume-button"
          data-testid="resume-button"
          onClick={onResume}
          disabled={resumeInFlight || accountStatus === "READY"}
          title={accountStatus === "READY" ? "Account is already READY" : "Resume requires zero outstanding commands"}
        >
          <Play size={14} aria-hidden="true" />
          {resumeInFlight ? "Resuming…" : "Resume"}
        </button>
        <ThemeToggle />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="btn btn-ghost workspace-trigger"
              aria-label="Workspace menu"
              title="Workspace menu"
              data-testid="workspace-menu"
            >
              <Ellipsis size={20} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={8} collisionPadding={12}>
              <DropdownMenu.Label className="menu-label">
                <span>Operator</span>
                <strong>{operatorId}</strong>
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item
                className="menu-item"
                onSelect={onExport}
                data-testid="export-run"
                title="Download the sanitized run export for pnpm verify:receipt"
              >
                <Download size={16} aria-hidden="true" />
                Export run
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={onRefresh} disabled={refreshing}>
                <RefreshCw size={16} aria-hidden="true" />
                {refreshing ? "Refreshing…" : "Refresh"}
                {lastRefreshAt !== null && (
                  <span className="muted small">{fmtDuration(Math.max(0, now - lastRefreshAt))} ago</span>
                )}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item" onSelect={onLogout}>
                <LogOut size={16} aria-hidden="true" />
                Log out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
