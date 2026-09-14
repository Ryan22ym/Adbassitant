import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';
import './pages/pages.css';

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
