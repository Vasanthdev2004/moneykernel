import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { describeEvent, type EventRefs, eventLabel, eventRefs, fmtAge, summarizeEvent } from "../format.ts";
import type { StreamStatus } from "../hooks.ts";
import { eventTone } from "../states.ts";
import type { AuditEvent } from "../types.ts";
import { Badge, Empty, Mono } from "./common.tsx";

const MAX_ROWS = 300;

export function Timeline({
  events,
  streamStatus,
  lastSeq,
  serverNow,
  onOpen,
}: {
  events: AuditEvent[];
  streamStatus: StreamStatus;
  lastSeq: number;
  serverNow: number;
  onOpen: (refs: EventRefs) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const rows = events
    .map((event) => ({
      event,
      description: describeEvent(event),
      searchText: summarizeEvent(event),
      refs: eventRefs(event),
    }))
    .filter(
      (row) =>
        needle.length === 0 ||
        row.event.type.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle) ||
        row.searchText.toLowerCase().includes(needle) ||
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
          <h2>Activity log</h2>
          <p className="panel-subtitle">
            {live} <span title={`Latest audit sequence ${lastSeq}`}>· {events.length} updates · newest first</span>
          </p>
        </div>
        <div className="panel-actions">
          <label htmlFor="timeline-filter" className="sr-only">
            Filter events
          </label>
          <input
            id="timeline-filter"
            className="filter-input"
            placeholder="Search activity"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </header>
      {rows.length === 0 ? (
        <Empty>{events.length === 0 ? "No events received yet." : "No events match the filter."}</Empty>
      ) : (
        <ol className="events">
          {rows.map(({ event, description, refs }) => {
            const tone = eventTone(event.type, event.payload);
            const hasRef = refs.intent_id !== null || refs.proposal_id !== null;
            return (
              <li
                className={`event tone-${tone}`}
                data-testid="timeline-event"
                data-event-type={event.type}
                key={event.id}
              >
                <span className={`event-marker event-marker-${tone}`} aria-hidden="true" />
                <div className="event-copy">
                  <strong className="event-title">{eventLabel(event.type)}</strong>
                  <p className="event-summary">{description}</p>
                  <div className="event-meta">
                    <span>{fmtAge(event.occurred_at, serverNow)}</span>
                    <Mono>{event.type}</Mono>
                    <Mono className="seq">#{event.account_seq}</Mono>
                  </div>
                </div>
                {hasRef && (
                  <button
                    type="button"
                    className="text-button event-open"
                    aria-label="open receipt"
                    onClick={() => onOpen(refs)}
                  >
                    View receipt <ArrowRight size={14} aria-hidden="true" />
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
