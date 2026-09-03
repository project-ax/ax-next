import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { runOAuthBridge } from './lib/oauth-callback-bridge';
import { BrandingProvider } from './lib/branding-context';
import { ErrorBoundary } from './components/ErrorBoundary';

if (!runOAuthBridge()) {
  // Last resort (TASK-273): catches throws above every per-surface
  // boundary in App — boot gate, providers — so the page never blanks.
  // Outside BrandingProvider on purpose: a branding throw must not blank
  // the page either.
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary surface="app">
      <BrandingProvider>
        <App />
      </BrandingProvider>
    </ErrorBoundary>,
  );
}
