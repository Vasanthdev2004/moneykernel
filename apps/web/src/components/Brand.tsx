export function Brand({ className }: { className?: string }) {
  return (
    <span className={`brand-lockup${className ? ` ${className}` : ""}`}>
      <img className="brand-mark" src="/brand/moneykernel-mark.png" width={34} height={34} alt="" aria-hidden="true" />
      <span className="brand">
        Money<span className="brand-accent">Kernel</span>
      </span>
    </span>
  );
}
