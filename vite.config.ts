import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: resolve(__dirname),
  resolve: {
    alias: [
      // 精确指向 TS 源文件，避免命中 tsc 生成的 shared/types.js
      { find: '@shared/types', replacement: resolve(__dirname, 'shared/types.ts') },
      { find: '@shared', replacement: resolve(__dirname, 'shared') },
      { find: '@', replacement: resolve(__dirname, 'src') },
    ],
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
