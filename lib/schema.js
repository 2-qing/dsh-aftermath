/**
 * 行 Config 的 schema（schemastery）。
 *
 * 为什么需要它：
 * - 没有 Config，插件的设置在宿主里没有命名空间，Plugins 页的配置卡片拿不到表单
 *   （`configForms.get('dsh-aftermath')` 返回 unavailable），只能改 yml 再重启。
 * - 所有字段都 `.volatile()`：改完立即生效，不重启插件（重启会丢掉当前基线与本轮状态）。
 *
 * 为什么 require 而不是 import：
 * - 顶层 `export const Config` 必须同步求值，动态 import 是异步的。
 * - `@deepseek-ai/schemastery` 提供 CJS 产物（`lib/index.cjs`），Node 22+ 的
 *   `createRequire` 能同步拿到；拿不到就退化为「不声明 Config」——
 *   代价只是没有图形界面，插件本身照常工作（此时宿主把 config 原样透传）。
 */
import { createRequire } from 'node:module';

const FIELD_DEFAULTS = {
  enabled: true,
  roots: ['desktop', 'downloads'],
  depth: 2,
  retentionDays: 7,
  maskHome: true,
  extraRoots: [],
  exclude: [
    'node_modules',
    '.git',
    '.vs',
    '.svn',
    '~$*',
    'Thumbs.db',
    'desktop.ini',
    '.DS_Store',
    '$RECYCLE.BIN',
    'System Volume Information',
  ],
  maxEntries: 20000,
  maxChangesPerReport: 200,
};

function loadSchemastery() {
  try {
    const require = createRequire(import.meta.url);
    const schema = require('@deepseek-ai/schemastery');
    if (!schema || typeof schema.object !== 'function') return null;
    // volatile() 是 live 编辑的前提；没有它的旧副本一律不用（否则字段不会实时生效）
    const probe = schema.string && schema.string();
    if (!probe || typeof probe.volatile !== 'function') return null;
    return schema;
  } catch {
    return null;
  }
}

function buildSchema() {
  const Schema = loadSchemastery();
  if (!Schema) return undefined;
  try {
    return Schema.object({
      /** 总开关：关掉后不再快照、不再写记录（命令仍可读历史）。 */
      enabled: Schema.boolean().default(FIELD_DEFAULTS.enabled).volatile(),
      /** 观测根：内置标识或绝对路径。 */
      roots: Schema.array(Schema.string()).default(FIELD_DEFAULTS.roots).volatile(),
      /** 递归层数。 */
      depth: Schema.number().min(0).max(6).default(FIELD_DEFAULTS.depth).volatile(),
      /** NDJSON 保留天数。 */
      retentionDays: Schema.number().min(1).max(90).default(FIELD_DEFAULTS.retentionDays).volatile(),
      /** 报告里把家目录打码成 ~。 */
      maskHome: Schema.boolean().default(FIELD_DEFAULTS.maskHome).volatile(),
      /** 额外的绝对路径根。 */
      extraRoots: Schema.array(Schema.string()).default(FIELD_DEFAULTS.extraRoots).volatile(),
      /** 名称排除模式。 */
      exclude: Schema.array(Schema.string()).default(FIELD_DEFAULTS.exclude).volatile(),
      /** 单根条目上限。 */
      maxEntries: Schema.number().min(100).max(200000).default(FIELD_DEFAULTS.maxEntries).volatile(),
      /** 一次报告最多列出的变更条数。 */
      maxChangesPerReport: Schema.number().min(10).max(2000).default(FIELD_DEFAULTS.maxChangesPerReport).volatile(),
    });
  } catch {
    return undefined;
  }
}

/** 宿主可见的行 Config（拿不到 schemastery 时为 undefined，宿主则原样透传配置）。 */
export const Config = buildSchema();

/** 从可能是 Volatile 引用的配置对象里取一个字段的真值。 */
export function readField(raw, key) {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}
