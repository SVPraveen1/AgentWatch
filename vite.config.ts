import { defineConfig, type HtmlTagDescriptor, type IndexHtmlTransformContext } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Content Security Policy for the overlay + dashboard.
 *
 * - Prod pages are loaded via `file://` from `loadFile()`, so everything must be same-origin:
 *   no remote scripts/styles/fonts, no XHR/fetch/WebSocket from the renderer (all data flows
 *   through the contextBridge IPC, never the network) — this is what makes the renderer's
 *   "zero outbound network" claim enforceable rather than aspirational.
 * - `style-src 'unsafe-inline'` is required: the dashboard writes inline `style` attributes for
 *   progress bars / heatmap cells.
 * - Dev relaxes `script-src`/`connect-src` only as far as Vite HMR needs (react-refresh injects
 *   an inline module preamble and opens a WebSocket to the dev server).
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function cspPlugin() {
  return {
    name: 'agentwatch:csp',
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): {
      html: string;
      tags: HtmlTagDescriptor[];
    } {
      const content = ctx.server ? DEV_CSP : PROD_CSP;
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: './',
  root: path.resolve(__dirname, 'src/renderer'),
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    // Emit a readable bundle so source maps survive the CSP (no inline/eval).
    sourcemap: false,
    rollupOptions: {
      input: {
        overlay: path.resolve(__dirname, 'src/renderer/overlay.html'),
        dashboard: path.resolve(__dirname, 'src/renderer/dashboard.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
