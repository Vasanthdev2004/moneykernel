import type { ReactNode } from "react";
import { amount, shortHash, trimDecimal } from "../format.ts";
import type { PolicyResponse } from "../types.ts";
import { DefList, Empty, ErrorNote, Mono, Panel, Timestamp } from "./common.tsx";

export function PolicyPanel({
  policy,
  missing,
  error,
}: {
  policy: PolicyResponse | null;
  missing: boolean;
  error?: string;
}) {
  if (policy === null) {
    return (
      <Panel id="policy" title="Policy" subtitle="read-only">
        <ErrorNote message={error} prefix="policy" />
        {missing ? (
          <Empty>No policy yet. Decisions are blocked until a reviewed policy version exists.</Empty>
        ) : (
          <Empty>Loading…</Empty>
        )}
      </Panel>
    );
  }
  const values = policy.policy;
  const quote = values.quote_asset;
  const items: Array<[string, ReactNode]> = [
    ["Max order notional", <Mono className="data">{amount(values.max_order_notional_quote, quote)}</Mono>],
    ["Max symbol share", <Mono className="data">{trimDecimal(values.max_symbol_share)} of equity floor</Mono>],
    ["Min quote cash buffer", <Mono className="data">{amount(values.min_quote_cash_buffer, quote)}</Mono>],
    ["Valuation buffer", <Mono className="data">{amount(values.valuation_buffer_quote, quote)}</Mono>],
    ["Max proposal age", <Mono className="data">{values.max_proposal_age_ms} ms</Mono>],
    ["Max market observation age", <Mono className="data">{values.max_market_observation_age_ms} ms</Mono>],
    ["Max account observation age", <Mono className="data">{values.max_account_observation_age_ms} ms</Mono>],
    ["Max price drift", <Mono className="data">{trimDecimal(values.max_price_drift_bps)} bps</Mono>],
    ["Conflict collection window", <Mono className="data">{values.conflict_collection_window_ms} ms</Mono>],
    ["Max unique intents / 60s", <Mono className="data">{values.max_unique_intents_per_60s}</Mono>],
    ["Max hard violations / 60s", <Mono className="data">{values.max_hard_violations_per_60s}</Mono>],
    [
      "Fee reserve rate",
      <Mono className="data">
        {trimDecimal(values.fee_rate)} ({values.fee_asset})
      </Mono>,
    ],
    ["Quote asset", <Mono>{quote}</Mono>],
  ];
  return (
    <Panel
      id="policy"
      title="Policy"
      subtitle={
        <>
          version <Mono>{policy.version}</Mono> · hash <Mono title={policy.hash}>{shortHash(policy.hash)}</Mono> · by{" "}
          {policy.created_by} · <Timestamp iso={policy.created_at} />
        </>
      }
    >
      <ErrorNote message={error} prefix="policy" />
      <DefList items={items} />
      <p className="muted small">Read-only in this gate. Values are reviewed product settings, not trading advice.</p>
    </Panel>
  );
}
