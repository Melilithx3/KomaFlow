import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port; in a plain browser the proxy makes the dev server same-origin.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true },
});
