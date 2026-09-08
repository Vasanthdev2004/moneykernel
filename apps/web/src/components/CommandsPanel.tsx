import { shortId, trimDecimal } from "../format.ts";
import { ACTION } from "../hooks.ts";
import { commandState } from "../states.ts";
import type { CommandDetail, CommandRecord } from "../types.ts";
import { Badge, Empty, ErrorNote, JsonBlock, Mono, Panel, StateBadge, Timestamp } from "./common.tsx";

export function needsReconcile(command: CommandRecord): boolean {
  return (
    command.state === "ARMED" ||
    command.state === "OUTCOME_UNKNOWN" ||
    (command.state === "ACCEPTED" && command.reconciled_at === null)
  );
}

function CommandDetailView({ detail }: { detail: CommandDetail }) {
  return (
    <div className="command-detail">
      <div>
        <span className="label">Order</span>{" "}
        {detail.order === null ? (
          <span className="muted small">none observed yet</span>
        ) : (
          <>
            <Badge tone="neutral">{detail.order.status}</Badge> <Mono>{detail.order.symbol}</Mono> · exchange id{" "}
            <Mono>{detail.order.exchange_order_id ?? "–"}</Mono> · executed{" "}
            <Mono className="data">{trimDecimal(detail.order.executed_base)}</Mono> base /{" "}
            <Mono className="data">{trimDecimal(detail.order.executed_quote)}</Mono> quote · observed{" "}
            <Timestamp iso={detail.order.last_observed_at} />
          </>
        )}
      </div>
      <div>
        <span className="label">Fills ({detail.fills.length})</span>{" "}
        {detail.fills.length === 0 ? (
          <span className="muted small">none reconciled</span>
        ) : (
          <ul className="plain">
            {detail.fills.map((fill) => (
              <li key={fill.id}>
                <Badge tone="green" glyph="✓">
                  reconciled fill
                </Badge>{" "}
                <Mono className="data">
                  {trimDecimal(fill.base_qty)} @ {trimDecimal(fill.price)} = {trimDecimal(fill.quote_qty)} · fee{" "}
                  {trimDecimal(fill.commission_qty)} {fill.commission_asset}
                </Mono>{" "}
                <span className="muted small">
                  <Timestamp iso={fill.event_time} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <span className="label">Ledger entries ({detail.ledger_entries.length})</span>{" "}
        {detail.ledger_entries.length === 0 ? (
          <span className="muted small">none</span>
        ) : (
          <ul className="plain">
            {detail.ledger_entries.map((entry) => (
              <li key={entry.id}>
                <Mono className="data">
                  {entry.sequence} · {trimDecimal(entry.signed_delta)} {entry.asset}
                </Mono>{" "}
                <span className="muted small">{entry.category}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {detail.reconciliation_schedule !== null && detail.reconciliation_schedule !== undefined && (
        <details className="details">
          <summary>Reconciliation schedule</summary>
          <JsonBlock value={detail.reconciliation_schedule} />
        </details>
      )}
      <details className="details">
        <summary>Exact payload</summary>
        <JsonBlock value={detail.command.exact_payload} />
      </details>
    </div>
  );
}

export function CommandsPanel({
  commands,
  expandedId,
  onToggle,
  detail,
  detailLoading,
  detailError,
  onReconcile,
  isInFlight,
  error,
}: {
  commands: CommandRecord[];
  expandedId: string | null;
  onToggle: (commandId: string) => void;
  detail: CommandDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  onReconcile: (command: CommandRecord) => void;
  isInFlight: (actionId: string) => boolean;
  error?: string;
}) {
  const sorted = [...commands].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const outstanding = commands.filter(needsReconcile).length;
  return (
    <Panel id="commands" title="Commands" subtitle={`${commands.length} total · ${outstanding} unreconciled`}>
      <ErrorNote message={error} prefix="commands" />
      {sorted.length === 0 ? (
        <Empty>
          No commands. Operator approval creates a READY command; the approval is consumed only when it arms.
        </Empty>
      ) : (
        <ul className="list">
          {sorted.map((command) => {
            const presentation = commandState(command.state);
            const expanded = expandedId === command.id;
            return (
              <li className="command" data-testid="command-row" data-state={command.state} key={command.id}>
                <div className="row-line">
                  <StateBadge presentation={presentation} showNote />
                  <Mono>{command.client_order_id}</Mono>
                  <Mono className="muted small" title={command.id}>
                    {shortId(command.id)}
                  </Mono>
                </div>
                <div className="muted small">
                  armed <Timestamp iso={command.armed_at} /> · reconciled <Timestamp iso={command.reconciled_at} /> ·
                  created <Timestamp iso={command.created_at} />
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => onToggle(command.id)}
                    aria-expanded={expanded}
                  >
                    {expanded ? "Hide details" : "Show order / fills"}
                  </button>
                  {needsReconcile(command) && (
                    <button
                      type="button"
                      className="btn btn-small"
                      data-testid="reconcile-button"
                      onClick={() => onReconcile(command)}
                      disabled={isInFlight(ACTION.reconcile(command.id))}
                    >
                      {isInFlight(ACTION.reconcile(command.id)) ? "Reconciling…" : "Reconcile"}
                    </button>
                  )}
                </div>
                {expanded && (
                  <>
                    <ErrorNote message={detailError} prefix="command" />
                    {detail !== null && detail.command.id === command.id ? (
                      <CommandDetailView detail={detail} />
                    ) : (
                      detailLoading && <p className="muted small">Loading…</p>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
