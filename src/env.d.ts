import type { AdbApi } from '../electron/preload';

declare global {
  interface Window {
    adbApi: AdbApi;
  }
  /**
   * 由 vite.config.ts 的 define 注入，取自 package.json 的 version。
   * 侧栏版本号用它渲染，避免手写版本号事后忘了同步。
   */
  const __APP_VERSION__: string;
}

export {};
