import { amount } from "../format.ts";
import { accountStatus } from "../states.ts";
import type { OverviewResponse, StatusResponse } from "../types.ts";
import { Badge, Mono } from "./common.tsx";

export function StatusStrip({
  status,
  overview,
}: {
  status: StatusResponse | null;
  overview: OverviewResponse | null;
}) {
  const account = overview?.account ?? status?.account ?? null;
  const presentation = accountStatus(account?.status ?? null);
  const readiness = overview?.readiness ?? status?.readiness ?? null;
  const failing = readiness ? readiness.checks.filter((check) => !check.ok).map((check) => check.name) : [];
  const quote = account?.quote_asset;
  const inFlight = overview?.in_flight_commands ?? status?.in_flight_commands ?? null;
  const unresolved = overview?.unresolved_commands ?? status?.unresolved_commands ?? null;

  return (
    <dl className="strip" aria-label="Account status">
      <div className="strip-item">
        <dt>Account</dt>
        <dd>
          <Badge tone={presentation.tone} glyph={presentation.glyph} title={presentation.note} testId="account-status">
            {presentation.label}
          </Badge>
          {account !== null && (
            <span className="muted small">
              {" "}
              {account.alias} · {account.environment}
            </span>
          )}
        </dd>
      </div>
      <div className="strip-item">
        <dt>Epoch</dt>
        <dd>
          <Mono>{account !== null ? account.epoch : "–"}</Mono>
        </dd>
      </div>
      <div className="strip-item">
        <dt>Available</dt>
        <dd>
          <Mono className="data">
            <span data-testid="available-quote">{overview ? amount(overview.available_quote, quote) : "–"}</span>
          </Mono>
        </dd>
      </div>
      <div className="strip-item">
        <dt>Reserved</dt>
        <dd>
          <Mono className="data">
            <span data-testid="reserved-quote">{overview ? amount(overview.reserved_quote, quote) : "–"}</span>
          </Mono>
        </dd>
      </div>
      <div className="strip-item">
        <dt>In-flight</dt>
        <dd>
          <Mono className={inFlight !== null && inFlight > 0 ? "data tone-amber" : "data"}>
            <span data-testid="in-flight">{inFlight ?? "–"}</span>
          </Mono>
        </dd>
      </div>
      <div className="strip-item">
        <dt>Unresolved</dt>
        <dd>
          <Mono className={unresolved !== null && unresolved > 0 ? "data tone-amber" : "data"}>
            <span data-testid="unresolved">{unresolved ?? "–"}</span>
          </Mono>
        </dd>
      </div>
      <div className="strip-item">
        <dt>Pending</dt>
        <dd>
          <Mono>{overview ? overview.pending_approvals : "–"}</Mono> approvals ·{" "}
          <Mono>{overview ? overview.open_conflicts : "–"}</Mono> conflicts
        </dd>
      </div>
      <div className="strip-item">
        <dt>Incidents</dt>
        <dd>
          {overview ? (
            <>
              <Mono className={overview.open_incidents.CRITICAL > 0 ? "tone-red" : ""}>
                {overview.open_incidents.CRITICAL}
              </Mono>{" "}
              critical ·{" "}
              <Mono className={overview.open_incidents.WARNING > 0 ? "tone-amber" : ""}>
                {overview.open_incidents.WARNING}
              </Mono>{" "}
              warning · <Mono>{overview.open_incidents.INFO}</Mono> info
            </>
          ) : (
            "–"
          )}
        </dd>
      </div>
      <div className="strip-item strip-readiness">
        <dt>Readiness</dt>
        <dd>
          {readiness === null ? (
            "–"
          ) : readiness.ready ? (
            <Badge tone="neutral" glyph="✓">
              ready
            </Badge>
          ) : (
            <>
              <Badge tone="amber" glyph="✕">
                not ready
              </Badge>{" "}
              <span className="muted small">{failing.join(", ") || "see integration panel"}</span>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}
