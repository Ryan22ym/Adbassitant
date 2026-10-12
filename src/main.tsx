import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';
import './pages/pages.css';
/*
 * 主题样式放最后：它要压过 global.css 里的 [data-accent] 变量块，
 * 而两者是同级选择器，只能靠加载顺序分胜负（详见 theme-genshin.css 文件头）。
 * 以后加新主题（比如崩铁）在下面接着排即可。
 */
import './styles/theme-genshin.css';

// 首屏先按浅色初始化，避免主题属性缺失导致样式闪烁；
// 随后 App 读取持久化设置再覆盖。
document.documentElement.setAttribute('data-theme', 'light');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
