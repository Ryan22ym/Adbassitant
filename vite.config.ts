import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// 从 package.json 取版本号注入到渲染层，避免侧栏版本号手写后忘记同步
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  base: './',
  root: resolve(__dirname),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
