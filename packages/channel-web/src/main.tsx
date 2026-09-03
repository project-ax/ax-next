import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { runOAuthBridge } from './lib/oauth-callback-bridge';
import { BrandingProvider } from './lib/branding-context';
import { ErrorBoundary } from './components/ErrorBoundary';

if (!runOAuthBridge()) {
  createRoot(document.getElementById('root')!).render(
    <BrandingProvider>
      {/* Last resort (TASK-273): catches throws above every per-surface
          boundary in App — boot gate, providers — so the page never blanks. */}
      <ErrorBoundary surface="app">
        <App />
      </ErrorBoundary>
    </BrandingProvider>,
  );
}
