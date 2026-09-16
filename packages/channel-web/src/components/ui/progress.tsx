import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, max, ...props }, ref) => {
  // Clamp to [0,max] so bad input (e.g. an upload progress fraction passed
  // through unmultiplied, or a stale value past the end) doesn't render the
  // indicator past the track edges via negative translateX.
  const ceiling = typeof max === 'number' && max > 0 ? max : 100;
  const normalizedValue =
    typeof value === 'number' ? Math.min(ceiling, Math.max(0, value)) : null;
  const percent =
    normalizedValue === null ? 0 : (normalizedValue / ceiling) * 100;
  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn(
        "relative h-4 w-full overflow-hidden rounded-full bg-secondary",
        className
      )}
      /*
        The CLAMPED value goes to the Root, not just to the transform below.
        It used to go nowhere: `value` was destructured out to compute the
        paint and never handed back, so every Progress in the app rendered as
        a progressbar with no `aria-valuenow` and a permanent
        `data-state="indeterminate"`. It looked right and announced nothing.
        Passing the clamped number keeps the announcement and the paint
        agreeing; `null` is Radix's own way of saying "genuinely unknown", so
        a Progress with no `value` stays honestly indeterminate.
      */
      value={normalizedValue}
      max={ceiling}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
