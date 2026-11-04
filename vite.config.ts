import { defineConfig } from 'vite';

// Draco / Basis (KTX2) decoders are referenced by three.js loaders through
// `new URL(..., import.meta.url)`, so Vite bundles them automatically.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
  },
});
