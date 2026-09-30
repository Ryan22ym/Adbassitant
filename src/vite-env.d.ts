/// <reference types="vite/client" />

/*
 * 让 TS 认识 `import icon from '@/assets/xxx.png'` 这类资源导入（vite/client 里已声明
 * *.png / *.svg / *.ico 等）。侧栏品牌标记就是这么引的 —— 图标文件在 src/assets/，
 * 由 scripts/make-icon.py 一并生成，和 exe / 任务栏用的那份同源。
 */
