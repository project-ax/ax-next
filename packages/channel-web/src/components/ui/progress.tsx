import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => {
  // Clamp to [0,100] so bad input (e.g. an upload progress fraction passed
  // through unmultiplied, or a stale value past 100) doesn't render the
  // indicator past the track edges via negative translateX.
  const normalizedValue =
    typeof value === 'number' ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn(
        "relative h-4 w-full overflow-hidden rounded-full bg-secondary",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - normalizedValue}%)` }}
      />
    </ProgressPrimitive.Root>
  );
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
