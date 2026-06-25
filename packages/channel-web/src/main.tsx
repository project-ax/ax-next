import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { runOAuthBridge } from './lib/oauth-callback-bridge';
import { BrandingProvider } from './lib/branding-context';

if (!runOAuthBridge()) {
  createRoot(document.getElementById('root')!).render(
    <BrandingProvider>
      <App />
    </BrandingProvider>,
  );
}
