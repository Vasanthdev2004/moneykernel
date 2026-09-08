import { evidenceFacts, shortId } from "../format.ts";
import { incidentSeverity } from "../states.ts";
import type { Agent, Incident } from "../types.ts";
import { Badge, Empty, ErrorNote, Mono, Panel, StateBadge, Timestamp } from "./common.tsx";

function IncidentRow({ incident, agentsById }: { incident: Incident; agentsById: Map<string, Agent> }) {
  const severity = incidentSeverity(incident.severity);
  const facts = evidenceFacts(incident.evidence_refs);
  return (
    <li className={`incident incident-${incident.status.toLowerCase()}`} data-testid="incident-row">
      <div className="row-line">
        <StateBadge presentation={severity} />
        <Badge tone={incident.status === "OPEN" ? "amber" : "muted"}>{incident.status}</Badge>
        <strong>{incident.type}</strong>
        {incident.agent_id !== null && (
          <span className="muted small">
            agent {agentsById.get(incident.agent_id)?.name ?? shortId(incident.agent_id)}
          </span>
        )}
      </div>
      <div className="muted small">
        <Mono title={incident.id}>{shortId(incident.id)}</Mono> · raised <Timestamp iso={incident.created_at} />
        {incident.resolved_at !== null && (
          <>
            {" "}
            · resolved <Timestamp iso={incident.resolved_at} /> by {incident.resolved_by ?? "?"}
          </>
        )}
      </div>
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map(([key, value]) => (
            <div className="deflist-row" key={key}>
              <dt>{key}</dt>
              <dd>
                <Mono className="data">{value}</Mono>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function IncidentsPanel({
  incidents,
  agentsById,
  error,
}: {
  incidents: Incident[];
  agentsById: Map<string, Agent>;
  error?: string;
}) {
  const byNewest = (a: Incident, b: Incident): number => b.created_at.localeCompare(a.created_at);
  const open = incidents.filter((incident) => incident.status === "OPEN").sort(byNewest);
  const resolved = incidents.filter((incident) => incident.status !== "OPEN").sort(byNewest);
  return (
    <Panel id="incidents" title="Incidents" subtitle={`${open.length} open · ${resolved.length} resolved`}>
      <ErrorNote message={error} prefix="incidents" />
      <p className="muted small prerequisites">
        Recovery prerequisites — OUTCOME_UNKNOWN: reconcile the command (Commands panel), then resume. QUARANTINE:
        acknowledge the incident in Resume; the agent stays quarantined until an operator reviews it. Resume always
        requires zero outstanding commands.
      </p>
      {open.length === 0 ? (
        <Empty>No open incidents.</Empty>
      ) : (
        <ul className="list">
          {open.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} agentsById={agentsById} />
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="details">
          <summary>Resolved ({resolved.length})</summary>
          <ul className="list">
            {resolved.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} agentsById={agentsById} />
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
