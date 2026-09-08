import { useState } from "react";
import { type EventRefs, eventRefs, summarizeEvent } from "../format.ts";
import type { StreamStatus } from "../hooks.ts";
import { eventTone } from "../states.ts";
import type { AuditEvent } from "../types.ts";
import { Badge, Empty, Mono, Timestamp } from "./common.tsx";

const MAX_ROWS = 300;

export function Timeline({
  events,
  streamStatus,
  lastSeq,
  onOpen,
}: {
  events: AuditEvent[];
  streamStatus: StreamStatus;
  lastSeq: number;
  onOpen: (refs: EventRefs) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const rows = events
    .map((event) => ({ event, summary: summarizeEvent(event), refs: eventRefs(event) }))
    .filter(
      (row) =>
        needle.length === 0 ||
        row.event.type.toLowerCase().includes(needle) ||
        row.summary.toLowerCase().includes(needle) ||
        row.event.id.toLowerCase().includes(needle),
    )
    .slice(0, MAX_ROWS);
  const live =
    streamStatus === "live" ? (
      <Badge tone="neutral" glyph="●">
        live
      </Badge>
    ) : streamStatus === "reconnecting" ? (
      <Badge tone="amber" glyph="↻">
        reconnecting
      </Badge>
    ) : streamStatus === "loading" ? (
      <Badge tone="muted" glyph="…">
        loading
      </Badge>
    ) : (
      <Badge tone="muted" glyph="○">
        off
      </Badge>
    );

  return (
    <section className="timeline" id="timeline" aria-label="Event timeline">
      <header className="panel-header">
        <div>
          <h2>Event timeline</h2>
          <p className="panel-subtitle">
            {live} · {events.length} events · last seq <Mono>{lastSeq}</Mono> · newest first
          </p>
        </div>
        <div className="panel-actions">
          <label htmlFor="timeline-filter" className="sr-only">
            Filter events
          </label>
          <input
            id="timeline-filter"
            className="filter-input"
            placeholder="Filter by type, id, or summary"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </header>
      {rows.length === 0 ? (
        <Empty>{events.length === 0 ? "No events received yet." : "No events match the filter."}</Empty>
      ) : (
        <ol className="events">
          {rows.map(({ event, summary, refs }) => {
            const tone = eventTone(event.type, event.payload);
            const hasRef = refs.intent_id !== null || refs.proposal_id !== null;
            return (
              <li
                className={`event tone-${tone}`}
                data-testid="timeline-event"
                data-event-type={event.type}
                key={event.id}
              >
                <Timestamp iso={event.occurred_at} />
                <Mono className="muted small seq">#{event.account_seq}</Mono>
                <Badge tone={tone}>{event.type}</Badge>
                <span className="event-summary">{summary}</span>
                {hasRef && (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => onOpen(refs)}>
                    open receipt
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
