import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 8765, host: 'localhost' },
  preview: { port: 8765, host: 'localhost' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
