/**
 * 版本号的单一来源：package.json。
 *
 * 之前是 lib/index.js 里的一个硬编码常量，跟 package.json 各改各的，
 * 结果 /aftermath status 显示 0.1.0、包却是 0.2.0。这里改成运行时读一次，
 * 读不到才退回 0.0.0（表示「读不到」，不是「旧版本」）。
 */
import { readFileSync } from 'node:fs';

const UNKNOWN = '0.0.0';

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch {
    // 打包裁剪、文件缺失、JSON 损坏都不该影响插件运行
  }
  return UNKNOWN;
}

export const VERSION = readVersion();