import type { Decorator, Preview } from '@storybook/react-vite';
import '../theme.css';
import '../ui.css';
import './preview.css';

type Theme = 'light' | 'dark';

// Sets data-theme on <html> before the story renders, so theme.css picks light or dark for the whole page.
const withTheme: Decorator = (Story, context) => {
  const theme: Theme = context.globals.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  return <Story />;
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Color theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [withTheme],
  parameters: { layout: 'padded' },
};

export default preview;
