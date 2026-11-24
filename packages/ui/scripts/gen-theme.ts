import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderThemeCss } from '../src/foundation/theme-css.js';

writeFileSync(fileURLToPath(new URL('../theme.css', import.meta.url)), renderThemeCss());
