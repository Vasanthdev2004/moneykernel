import { amount } from "../format.ts";
import type { OverviewResponse, StatusResponse } from "../types.ts";

export function StatusStrip({
  status,
  overview,
}: {
  status: StatusResponse | null;
  overview: OverviewResponse | null;
}) {
  const quote = overview?.account.quote_asset ?? status?.account.quote_asset;
  return (
    <dl className="funds-strip" aria-label="Account funds">
      <div>
        <dt>Available to allocate</dt>
        <dd data-testid="available-quote">{overview ? amount(overview.available_quote, quote) : "—"}</dd>
        <span>After reservations and your cash buffer</span>
      </div>
      <div>
        <dt>Reserved for trades</dt>
        <dd data-testid="reserved-quote">{overview ? amount(overview.reserved_quote, quote) : "—"}</dd>
        <span>Held until a decision is resolved</span>
      </div>
      <div>
        <dt>Cash buffer</dt>
        <dd data-testid="cash-buffer-quote">{overview ? amount(overview.cash_buffer_quote, quote) : "—"}</dd>
        <span>Kept outside new spending authority</span>
      </div>
    </dl>
  );
}
