import { useResolvedTheme } from '@/lib/theme';
import markLight from '@/assets/design/ax-mark-light.svg';
import markDark from '@/assets/design/ax-mark-dark.svg';
import smallLight from '@/assets/design/ax-mark-small-light.svg';
import smallDark from '@/assets/design/ax-mark-small-dark.svg';

/** Original Figma artwork at its exported dimensions. */
export function AxDesignMark({ small = false }: { small?: boolean }) {
  const dark = useResolvedTheme() === 'dark';
  const src = small ? (dark ? smallDark : smallLight) : (dark ? markDark : markLight);
  const size = small ? 18 : 27;
  return <img src={src} width={size} height={size} alt="" aria-hidden="true" className="shrink-0" />;
}
