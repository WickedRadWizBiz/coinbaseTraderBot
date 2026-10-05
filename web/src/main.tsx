import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { installCrtBulge } from './crtBulge';

// Purge service workers/caches left by the previous PWA build.
try {
  navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => r.unregister().catch(() => {}))).catch(() => {});
  if ('caches' in window) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k).catch(() => {}))).catch(() => {});
} catch { /* sandboxed */ }

installCrtBulge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
