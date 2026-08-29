import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      // shared/ sits above this package and holds the email-rendering policy
      // both the desktop and mobile clients enforce. The production build
      // resolves it fine; the dev server needs to be told it may read it.
      allow: ['..', fileURLToPath(new URL('../../shared', import.meta.url))],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE streaming support
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache';
            }
          });
        }
      }
    }
  }
})
