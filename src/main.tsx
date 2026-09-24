import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import './index.css';

// Purge any lingering service workers and caches from previous versions
try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().catch(() => {});
      }
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then((names) => {
      for (const name of names) {
        caches.delete(name).catch(() => {});
      }
    }).catch(() => {});
  }
} catch {
  // Ignore in sandboxed environments
}

const rootElement = document.getElementById('root');
if (rootElement) {
  try {
    createRoot(rootElement).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (err: any) {
    console.error('Fatal mount error:', err);
    rootElement.innerHTML = `
      <div style="min-height: 100vh; background: #0c0e15; color: #ff549a; font-family: monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center;">
        <h2 style="font-size: 20px; margin-bottom: 12px; letter-spacing: 2px;">PREDICTIONS RUNNER RECOVERY</h2>
        <p style="color: #e6e0ff; font-size: 13px; max-width: 500px; margin-bottom: 20px;">A runtime error prevented initial rendering.</p>
        <pre style="background: rgba(0,0,0,0.6); padding: 12px; border: 1px solid #ff549a; max-width: 90%; overflow-x: auto; margin-bottom: 20px;">${err?.message || err}</pre>
        <button onclick="window.location.reload()" style="background: #ff549a; color: white; border: none; padding: 10px 20px; font-weight: bold; cursor: pointer; text-transform: uppercase;">Reload Page</button>
      </div>
    `;
  }
}


