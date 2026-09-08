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
        <strong>OUTCOME UNKNOWN</strong>{" "}
        {unknownCount > 0
          ? `${unknownCount} command${unknownCount === 1 ? " has" : "s have"} an unknown execution outcome.`
          : "The account is reconciling an outstanding command."}{" "}
        Reservations stay held until the venue answer is reconciled; nothing here assumes success or failure. Recovery:
        reconcile the command in the <a href="#commands">Commands panel</a>, review the{" "}
        <a href="#incidents">Incidents panel</a>, then resume.
      </div>
    </section>
  );
}
