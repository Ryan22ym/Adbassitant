/** 展示用工具函数 */

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(ts: number, withMs = false): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withMs ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function shortPath(p: string, max = 46): string {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  const file = parts[parts.length - 1];
  const head = parts[0];
  const avail = max - file.length - 6;
  if (avail <= 0) return `…${file.slice(-max + 1)}`;
  return `${head}${p.includes('\\') ? '\\' : '/'}…\\${file}`;
}

export function fileName(p: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
