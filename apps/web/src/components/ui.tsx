import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export function UiProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={350}>{children}</TooltipPrimitive.Provider>;
}

export function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="tooltip" sideOffset={7} collisionPadding={12}>
          {label}
          <TooltipPrimitive.Arrow className="tooltip-arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function UsageMeter({ label, value, detail }: { label: string; value: number; detail: ReactNode }) {
  const bounded = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div className="usage-meter">
      <div className="usage-meter-heading">
        <span>{label}</span>
        <strong>{detail}</strong>
      </div>
      <ProgressPrimitive.Root className="progress" value={bounded} aria-label={label}>
        <ProgressPrimitive.Indicator
          className="progress-indicator"
          style={{ transform: `translateX(-${100 - bounded}%)` }}
        />
      </ProgressPrimitive.Root>
    </div>
  );
}

export function ScrollViewport({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollAreaPrimitive.Root className={className ? `scroll-area ${className}` : "scroll-area"}>
      <ScrollAreaPrimitive.Viewport className="scroll-viewport">{children}</ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar className="scrollbar" orientation="vertical">
        <ScrollAreaPrimitive.Thumb className="scrollbar-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
