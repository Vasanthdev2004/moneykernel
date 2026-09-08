import type { AccountStatus } from "../types.ts";

/**
 * Stays visible until the kernel reports zero unknown outcomes and the account
 * has left RECONCILING (prd.md 17.4). Never auto-dismissed, never turned green.
 */
export function UnknownBanner({
  unknownCount,
  accountStatus,
}: {
  unknownCount: number;
  accountStatus: AccountStatus | null;
}) {
  if (unknownCount === 0 && accountStatus !== "RECONCILING") return null;
  return (
    <section className="banner banner-unknown" role="alert" data-testid="unknown-banner">
      <span className="glyph" aria-hidden="true">
        ?
      </span>
      <div>
        <strong>{unknownCount > 0 ? "OUTCOME UNKNOWN" : "ACCOUNT RECONCILING"}</strong>{" "}
        {unknownCount > 0
          ? `${unknownCount} command${unknownCount === 1 ? " has" : "s have"} an unknown execution outcome.`
          : "The account requires reconciliation or investigation; new orders remain blocked."}{" "}
        {unknownCount > 0 &&
          "Reservations stay held until the unknown execution is reconciled; nothing here assumes success or failure. "}
        Recovery: {unknownCount > 0 ? "reconcile the command" : "review the command evidence"} in the{" "}
        <a href="#commands">Commands panel</a>, review the <a href="#incidents">Incidents panel</a>, then resume when
        kernel readiness permits.
      </div>
    </section>
  );
}
