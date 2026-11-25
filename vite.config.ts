import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  base: '/',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'esnext',
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7432',
      '/mcp': 'http://127.0.0.1:7432',
      '/auth': 'http://127.0.0.1:7432',
      '/oauth': 'http://127.0.0.1:7432',
      '/.well-known': 'http://127.0.0.1:7432',
      '/healthz': 'http://127.0.0.1:7432',
    },
  },
});
