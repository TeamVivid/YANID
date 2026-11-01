import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5067,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
