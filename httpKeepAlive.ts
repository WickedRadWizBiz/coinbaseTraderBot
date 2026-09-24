import https from 'https';
import http from 'http';

let isInitialized = false;

/**
 * Initializes persistent HTTP/HTTPS Keep-Alive connection pooling globally
 * across the Node.js runtime while maintaining full native automatic decompression
 * for gzip, deflate, and brotli payloads.
 */
export function initializeHttpKeepAlive(): void {
  if (isInitialized) return;
  
  try {
    (https.globalAgent as any).keepAlive = true;
    (https.globalAgent as any).keepAliveMsecs = 60000;
    https.globalAgent.maxSockets = 50;

    (http.globalAgent as any).keepAlive = true;
    (http.globalAgent as any).keepAliveMsecs = 60000;
    http.globalAgent.maxSockets = 50;

    isInitialized = true;
    console.log('[HTTP KEEP-ALIVE] Persistent HTTP/HTTPS Keep-Alive connection pool active with native automatic payload decompression.');
  } catch (err: any) {
    console.error('[HTTP KEEP-ALIVE] Error setting global keep-alive agents:', err?.message || err);
  }
}
