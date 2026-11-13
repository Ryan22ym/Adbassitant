import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import MirrorBar from './components/MirrorBar';
import MirrorSplash from './components/MirrorSplash';
import './styles/global.css';
import './pages/pages.css';
/*
 * 主题样式放最后：它要压过 global.css 里的 [data-accent] 变量块，
 * 而两者是同级选择器，只能靠加载顺序分胜负（详见 theme-genshin.css 文件头）。
 * 以后加新主题（比如崩铁）在下面接着排即可。
 */
import './styles/theme-genshin.css';
/*
 * 明日方舟主题（v1.1.17）：白面板 / 近黑侧栏 / 标志蓝 / 全直角。
 * 同样必须排在 global.css 之后（理由同上面那段）。
 */
import './styles/theme-arknights.css';
/*
 * 透明玻璃主题（v1.1.13）：同样必须排在 global.css 之后，理由同上。
 * 它与原神是两套互斥的 data-theme 值，谁后加载不影响对方（永远只有一个命中）。
 */
import './styles/theme-glass.css';
/*
 * 投屏窗口的功能栏（v1.1.22）。
 * 最后一个加载：它要把该窗口的 body 底色整个抹掉（透明小窗），
 * 排在主题之后才压得住 --bg-app 那一层。作用域限定在 [data-win='mirror-bar']，
 * 主窗口不受影响。
 */
import './styles/mirror-bar.css';
/*
 * 投屏启动期间的「正在投屏」提示牌（v1.1.23）。
 * 同样要最后加载：它也要把 body 底色抹掉（透明小窗），作用域 [data-win='mirror-splash']。
 */
import './styles/mirror-splash.css';

// 首屏先按浅色初始化，避免主题属性缺失导致样式闪烁；
// 随后 App 读取持久化设置再覆盖。
document.documentElement.setAttribute('data-theme', 'light');

/*
 * 同一个 bundle 承载三个窗口（v1.1.22 / v1.1.23）：
 *   · 默认 → 主界面（HashRouter 里的 App）
 *   · `#/mirror-bar` → 投屏窗口右侧那条悬浮功能栏
 *     （窗口由 electron/services/mirror-bar.ts 建，透明、无边框、不抢焦点）
 *   · `#/mirror-splash` → 等首帧期间的「正在投屏」提示牌
 *     （electron/services/mirror-splash.ts，同样透明、不抢焦点）
 * 后两个都不能套主界面的外壳，所以这里在路由之外直接分流。
 */
const isMirrorBar = window.location.hash.startsWith('#/mirror-bar');
const isMirrorSplash = window.location.hash.startsWith('#/mirror-splash');
if (isMirrorBar) document.documentElement.setAttribute('data-win', 'mirror-bar');
if (isMirrorSplash) document.documentElement.setAttribute('data-win', 'mirror-splash');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isMirrorBar ? (
      <MirrorBar />
    ) : isMirrorSplash ? (
      <MirrorSplash />
    ) : (
      <HashRouter>
        <App />
      </HashRouter>
    )}
  </React.StrictMode>,
);
