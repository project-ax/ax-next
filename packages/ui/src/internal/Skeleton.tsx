import { cx } from './cx.js';

export type SkeletonShape = 'rows' | 'lines' | 'block';

const BAR = 'ax-bg-muted ax-rounded-md ax-animate-pulse motion-reduce:ax-animate-none';

// Placeholder shaped like the content it stands in for (rule 7). Decorative: AsyncState supplies the accessible label.
export function Skeleton({ shape }: { shape: SkeletonShape }) {
  if (shape === 'block') {
    return <div aria-hidden="true" className={cx(BAR, 'ax-h-skeleton-block ax-w-full')} />;
  }
  if (shape === 'rows') {
    return (
      <div aria-hidden="true" className="ax-flex ax-flex-col ax-gap-md">
        <div className={cx(BAR, 'ax-h-control-md ax-w-full')} />
        <div className={cx(BAR, 'ax-h-control-md ax-w-full')} />
        <div className={cx(BAR, 'ax-h-control-md ax-w-full')} />
      </div>
    );
  }
  return (
    <div aria-hidden="true" className="ax-flex ax-flex-col ax-gap-sm">
      <div className={cx(BAR, 'ax-h-lg ax-w-full')} />
      <div className={cx(BAR, 'ax-h-lg ax-w-9/10')} />
      <div className={cx(BAR, 'ax-h-lg ax-w-3/5')} />
    </div>
  );
}
