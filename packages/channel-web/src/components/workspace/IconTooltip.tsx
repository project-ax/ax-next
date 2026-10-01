import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function IconTooltip({
  label,
  children,
  side = 'bottom',
  className = '',
}: {
  label: string;
  children: React.ReactElement;
  side?: 'left' | 'right' | 'top' | 'bottom';
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex shrink-0 ${className}`}>
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
