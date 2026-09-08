import { Bot, BrainCircuit, ChartCandlestick, type LucideIcon, ShieldCheck } from "lucide-react";
import { fmtAge } from "../format.ts";
import { integrationState } from "../states.ts";
import type { IntegrationKey, StatusResponse } from "../types.ts";
import { Badge, DefList, Empty, ErrorNote, Mono, Panel, StateBadge, Timestamp } from "./common.tsx";

const ENTRIES: ReadonlyArray<[IntegrationKey, string, LucideIcon]> = [
  ["agent_os_mcp", "Agent OS MCP", Bot],
  ["market_data", "Market data", ChartCandlestick],
  ["execution", "Execution", ShieldCheck],
  ["model", "Model", BrainCircuit],
];

export function IntegrationPanel({
  status,
  serverNow,
  error,
}: {
  status: StatusResponse | null;
  serverNow: number;
  error?: string;
}) {
  return (
    <Panel
      id="integration"
      title="Integration & provenance"
      subtitle={status ? `engine ${status.engine_version}` : "not loaded"}
    >
      <ErrorNote message={error} prefix="status" />
      {status === null ? (
        <Empty>Kernel status not loaded.</Empty>
      ) : (
        <>
          <ul className="list">
            {ENTRIES.map(([key, label, Icon]) => {
              const entry = status.integration[key];
              const presentation = integrationState(entry.state);
              return (
                <li className="integration" key={key}>
                  <div className="integration-icon" aria-hidden="true">
                    <Icon size={18} strokeWidth={1.8} />
                  </div>
                  <div className="integration-copy">
                    <div className="row-line">
                      <strong>{label}</strong>
                      <StateBadge presentation={presentation} />
                    </div>
                    <div className="small">{entry.detail}</div>
                    <div className="muted small">
                      last successful read:{" "}
                      {entry.last_successful_read_at === null ? (
                        "never"
                      ) : (
                        <>
                          <Timestamp iso={entry.last_successful_read_at} /> ·{" "}
                          <Mono>{fmtAge(entry.last_successful_read_at, serverNow)}</Mono>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <h4>Provenance</h4>
          <DefList
            items={[
              ["Execution mode", <Mono>{status.provenance.execution_mode}</Mono>],
              ["Market source", <Mono>{status.provenance.market_source}</Mono>],
              ["Model source", <Mono>{status.provenance.model_source}</Mono>],
              ["Execution source", <Mono>{status.provenance.execution_source}</Mono>],
              ["Server time", <Timestamp iso={status.server_time} />],
            ]}
          />
          <h4>
            Readiness{" "}
            {status.readiness.ready ? (
              <Badge tone="neutral" glyph="✓">
                ready
              </Badge>
            ) : (
              <Badge tone="amber" glyph="✕">
                not ready
              </Badge>
            )}
          </h4>
          <ul className="plain checks-list">
            {status.readiness.checks.map((check) => (
              <li key={check.name} className={check.ok ? "" : "tone-amber"}>
                <span className="glyph" aria-hidden="true">
                  {check.ok ? "✓" : "✕"}
                </span>{" "}
                <Mono>{check.name}</Mono>{" "}
                <span className="muted small">
                  {check.ok ? "ok" : "failing"} · {check.detail}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
