import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { app, nativeImage, screen } from 'electron';
import { execFile } from 'child_process';

/*
 * 壁纸读取（v1.1.14）：给「模拟玻璃」主题当底图。
 *
 * 🔴 为什么不再用 desktopCapturer 截整屏：截屏截到的是**整个桌面** ——
 *    图标、打开的窗口、任务栏全在里面，玻璃底下透出来的不是「壁纸」而是
 *    「开机的乱七八糟」。用户要的是壁纸本身。
 *
 * 来源优先级：
 *   1. TranscodedWallpaper —— 系统把当前壁纸按屏幕比例转码后的 JPEG，
 *      %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper。
 *      轮换壁纸（幻灯片）时系统会随换随写，每次启动重读即拿到「当前」壁纸。
 *   2. 注册表 HKCU\Control Panel\Desktop 的 Wallpaper 值 —— 原始壁纸文件路径。
 *      幻灯片模式下这个值不一定跟手，所以只当兜底。
 *   3. 都失败返回 null —— 调用方（ipc.ts）再退回整屏截图，最后退回纯色。
 *
 * ⚠️ 每次调用都现读文件，不缓存：主题切换/重启时渲染层会重新来拿，
 *    自然满足「每次重启时更新」。文件就几 MB，读一次可接受。
 */

/** 按文件头魔数判 MIME —— 别信扩展名（TranscodedWallpaper 就没有扩展名）。 */
function magicMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  return null;
}

function fileToDataURL(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    const buf = readFileSync(p);
    /* 空文件 / 太小的不当壁纸（<1KB 基本是残片） */
    if (buf.length < 1024) return null;
    const mime = magicMime(buf);
    if (!mime) return null;
    /*
     * 4K 壁纸原始文件可能 10MB+，直接 base64 会变成 15MB 的 data URL。
     * 用 nativeImage 解码后缩到**主屏物理尺寸**（与 backdrop 的 background-size:cover
     * 对齐）再转 JPEG —— 内存和 IPC 体积都砍一个数量级，视觉无损（本来就是糊玻璃的底）。
     * nativeImage 不认的格式（老 BMP 变体等）直接退回原始 base64，别因此黑屏。
     */
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      const d = screen.getPrimaryDisplay();
      const w = Math.round(d.size.width * d.scaleFactor);
      const h = Math.round(d.size.height * d.scaleFactor);
      const resized = img.resize({ width: w, height: h });
      if (!resized.isEmpty()) {
        return `data:image/jpeg;base64,${resized.toJPEG(85).toString('base64')}`;
      }
    }
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** 读注册表里登记的壁纸路径（读失败返回 null，不抛 —— 兜底路径而已）。 */
function readRegistryWallpaper(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        /* 输出形如：  Wallpaper    REG_SZ    C:\Users\...\wallpaper.jpg */
        const m = stdout.match(/Wallpaper\s+REG_SZ\s+(.+)/i);
        const p = m ? m[1].trim() : '';
        resolve(p || null);
      },
    );
  });
}

/** 拿当前壁纸的 data URL；三级来源都失败时返回 null。 */
export async function getWallpaperDataURL(): Promise<string | null> {
  /* 1. 系统转码后的当前壁纸（幻灯片/填充方式都已处理好，优先级最高） */
  const trans = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  const a = fileToDataURL(trans);
  if (a) return a;

  /* 2. 注册表指向的原始壁纸文件 */
  const regPath = await readRegistryWallpaper();
  if (regPath) {
    const b = fileToDataURL(regPath);
    if (b) return b;
  }

  /* 3. 都拿不到，交给调用方兜底（整屏截图 / 纯色） */
  return null;
}
