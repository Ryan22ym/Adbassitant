import type { AdbApi } from '../electron/preload';

declare global {
  interface Window {
    adbApi: AdbApi;
  }
}

export {};
