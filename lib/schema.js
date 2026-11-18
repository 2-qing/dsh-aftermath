/**
 * 行 Config 的 schema（schemastery）。
 *
 * 为什么需要它：
 * - 没有 Config，插件的设置在宿主里没有命名空间，Plugins 页的配置卡片拿不到表单，
 *   除总开关外都改不动，只能改 yml 再重启。
 * - 所有字段都 `.volatile()`：改完立即生效，不重启插件（重启会丢掉当前基线与本轮状态）。
 *
 * 为什么不要简单 createRequire(import.meta.url)：
 * - 插件用 `link:` 装时（DSH 对本地目录就是这么做），node_modules 里是符号链接，
 *   而 Node 默认按 realpath 解析 import.meta.url —— 真实路径可能是别的盘、别的目录，
 *   从那里往上层找不到 `@deepseek-ai/schemastery`，Config 就静默变成 undefined，
 *   表现是「设置页只有总开关能改」。所以这里要显式补上几个搜索根。
 *
 * 为什么 require 而不是 import：
 * - 顶层 `export const Config` 必须同步求值，动态 import 是异步的。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@deepseek-ai/schemastery';

export const FIELD_DEFAULTS = {
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
  intervalSlackMs: 1500,
  recordQuietTurns: true,
};

/**
 * Desktop 版把依赖打进 `resources/app.asar/dsh/node_modules`，路径既不在
 * profile 里也不在环境变量里，只能从运行时自身的位置推出来。这里用 execPath
 * 与 resourcesPath 拼出候选目录；两个都拿不到时返回空数组。
 */
export function installDirCandidates(runtime = {}) {
  // 显式传进来的键优先（哪怕是 undefined，代表「这条路径我不提供」），
  // 没传的键才回退到当前运行时。
  const own = Object.prototype.hasOwnProperty;
  const execPath = own.call(runtime, 'execPath') ? runtime.execPath : process.execPath;
  const resourcesPath = own.call(runtime, 'resourcesPath') ? runtime.resourcesPath : process.resourcesPath;
  const out = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const dir = value.trim();
    if (dir && !out.includes(dir)) out.push(dir);
  };
  if (typeof resourcesPath === 'string') {
    push(join(resourcesPath, 'app.asar', 'dsh', 'node_modules'));
    push(join(resourcesPath, 'app', 'dsh', 'node_modules'));
  }
  if (typeof execPath === 'string') {
    const dir = dirname(execPath);
    push(join(dir, 'resources', 'app.asar', 'dsh', 'node_modules'));
    push(join(dir, 'resources', 'app', 'dsh', 'node_modules'));
  }
  return out;
}

/**
 * 候选搜索根：Node 的 CJS 解析器会把每个目录当成 node_modules 的搜索起点。
 * 顺序 = 越可能命中越前。全部来自宿主自己的环境，不做任何猜测式遍历。
 */
export function resolutionBases(env = process.env) {
  const bases = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const dir = value.trim();
    if (!dir || bases.includes(dir)) return;
    bases.push(dir);
  };

  // 1) 本文件所在目录（常规 node_modules 安装时这一条就够）
  try {
    push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* ignore */
  }
  // 2) 宿主明确告知的 profile 目录（link: 安装时依赖都装在这里）
  push(env.DSH_PROFILE_DIR);
  // 3) 安装目录（Desktop 版 @deepseek-ai/* 的另一处来源）
  push(env.DSH_INSTALL_DIR);
  push(env.DSH_INSTALL_DIR ? join(env.DSH_INSTALL_DIR, '..') : undefined);
  // 4) $DSH_HOME/profiles/<当前 profile> 与 $DSH_HOME 下的公共位置
  if (env.DSH_HOME) {
    push(join(env.DSH_HOME, 'profiles', 'desktop', 'node_modules'));
    push(join(env.DSH_HOME, 'node_modules'));
  }
  // 5) Desktop 版安装目录（asar 内自带一份 @deepseek-ai/schemastery）
  for (const dir of installDirCandidates()) push(dir);
  // 6) 老实的兜底：环境里没告知时，按 profile 的常见位置试一次
  if (!env.DSH_PROFILE_DIR && env.DSH_HOME) push(join(env.DSH_HOME, 'profiles', 'desktop'));

  return bases;
}

/** 真正的加载器；返回 { schema, source }，source 用于自检。 */
export function loadSchemastery(env = process.env) {
  const require = createRequire(import.meta.url);

  const accept = (schema, source) => {
    if (!schema || typeof schema.object !== 'function') return null;
    // volatile() 是 live 编辑的前提；没有它的旧副本一律不用（否则字段不会实时生效）
    const probe = typeof schema.string === 'function' ? schema.string() : null;
    if (!probe || typeof probe.volatile !== 'function') return null;
    return { schema, source };
  };

  // 直接解析（正常安装路径）
  try {
    const direct = accept(require(PACKAGE), 'local');
    if (direct) return direct;
  } catch {
    /* 继续用候选根 */
  }

  // 从每个候选根解析出文件再加载：require.resolve 的 paths 选项会按
  // node_modules 规则逐级上溯，因此这里传目录即可。
  for (const base of resolutionBases(env)) {
    let file = null;
    try {
      file = require.resolve(PACKAGE, { paths: [base] });
    } catch {
      continue;
    }
    try {
      const resolved = accept(require(file), base);
      if (resolved) return resolved;
    } catch {
      /* 换下一个根 */
    }
  }

  return null;
}

/** 按已加载的 schemastery 构造行 Config；拿不到 schemastery 时为 undefined。 */
function buildSchema(S) {
  if (!S) return undefined;
  try {
    return S.object({
      /** 总开关：关掉后不再快照、不再写记录（命令仍可读历史）。 */
      enabled: S.boolean().default(FIELD_DEFAULTS.enabled).volatile(),
      /** 观测根：内置标识或绝对路径。 */
      roots: S.array(S.string()).default(FIELD_DEFAULTS.roots).volatile(),
      /** 递归层数。 */
      depth: S.number().min(0).max(6).default(FIELD_DEFAULTS.depth).volatile(),
      /** NDJSON 保留天数。 */
      retentionDays: S.number().min(1).max(90).default(FIELD_DEFAULTS.retentionDays).volatile(),
      /** 报告里把家目录打码成 ~。 */
      maskHome: S.boolean().default(FIELD_DEFAULTS.maskHome).volatile(),
      /** 零变更但执行过写操作的回合，也落一条轻记录（判定“这轮动过别处”的唯一线索）。 */
      recordQuietTurns: S.boolean().default(FIELD_DEFAULTS.recordQuietTurns).volatile(),
      /** 额外的绝对路径根。 */
      extraRoots: S.array(S.string()).default(FIELD_DEFAULTS.extraRoots).volatile(),
      /** 名称排除模式。 */
      exclude: S.array(S.string()).default(FIELD_DEFAULTS.exclude).volatile(),
      /** 单根条目上限。 */
      maxEntries: S.number().min(100).max(200000).default(FIELD_DEFAULTS.maxEntries).volatile(),
      /** 一次报告最多列出的变更条数。 */
      maxChangesPerReport: S.number().min(10).max(2000).default(FIELD_DEFAULTS.maxChangesPerReport).volatile(),
      /** 调用区间归因的容差（毫秒）。 */
      intervalSlackMs: S.number().min(0).max(60000).default(FIELD_DEFAULTS.intervalSlackMs).volatile(),
      /** 会话工作目录自动计入观测根。 */
      followCwd: S.boolean().default(FIELD_DEFAULTS.followCwd).volatile(),
    });
  } catch {
    return undefined;
  }
}

const BUILT = loadSchemastery();

/** 宿主可见的行 Config（拿不到 schemastery 时为 undefined，宿主则原样透传配置）。 */
export const Config = buildSchema(BUILT && BUILT.schema);

/** schema 来源自检：'local' / 具体搜索根 / null（未加载）。 */
export const SCHEMA_SOURCE = BUILT ? BUILT.source : null;

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

export { buildSchema };
