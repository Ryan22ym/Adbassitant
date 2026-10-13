import { useApp } from '@/store/app';
import { featureOnOf, panelOpenOf, type UiConf } from '@shared/ui-conf';

/**
 * 界面配置（Conf/*.json）在渲染层的读取入口。
 *
 * 为什么统一走 hook 而不是到处直接读 store：
 *   配置是**启动后异步**从主进程取回来的（store 初值只是出厂默认）。
 *   用 hook = 订阅，配置一到相关组件就重渲染；
 *   用 `useApp.getState()` 拿快照的话，配置到位时不会触发重渲染，
 *   于是「用户改过的顺序 / 展开状态」要等到下次导航才生效 —— 这类 bug 很难查。
 */

/** 当前生效的界面配置（已由主进程合并过出厂默认，字段完整） */
export function useUiConf(): UiConf {
  return useApp((s) => s.uiConf);
}

/**
 * 某个功能块默认是否展开。
 * @param page  页面 id，如 'device'
 * @param block 功能块 id，如 'detail'
 */
export function usePanelOpen(page: string, block: string): boolean {
  const conf = useApp((s) => s.uiConf);
  return panelOpenOf(conf, page, block);
}

/**
 * 某个入口是否显示。
 * @param group 分组 id，如 'nav' / 'tools' / 'device'
 * @param key   条目 id，如 'mirror'
 */
export function useFeature(group: string, key: string): boolean {
  const conf = useApp((s) => s.uiConf);
  return featureOnOf(conf, group, key);
}
