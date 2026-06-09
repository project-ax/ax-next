import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { runOAuthBridge } from './lib/oauth-callback-bridge';

if (!runOAuthBridge()) {
  createRoot(document.getElementById('root')!).render(<App />);
}
