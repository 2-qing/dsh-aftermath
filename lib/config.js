/**
 * 配置与根目录解析。
 *
 * 硬约束（本机实测）：宿主进程里调用 `reg.exe` 不可靠（任何参数都报「无效语法」），
 * 因此这里不读注册表、不启子进程，只用 USERPROFILE + 别名探测 + 显式配置三级回退。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  enabled: true,
  /** 根标识或绝对路径；内置标识见 ROOT_ALIASES */
  roots: ['desktop', 'downloads'],
  /** 每个根向下递归的层数；0 = 只看根目录本身 */
  depth: 2,
  /** 单根条目上限，超限截断并标记 */
  maxEntries: 20000,
  /** 一次报告最多列出的变更条数 */
  maxChangesPerReport: 200,
  /** NDJSON 保留天数 */
  retentionDays: 7,
  /** 名称排除模式：精确名 / `前缀*` / `*后缀`，大小写不敏感 */
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
  /** 额外绝对路径根（与 roots 合并） */
  extraRoots: [],
  /** 是否在报告里把绝对路径打码成 ~ */
  maskHome: true,
  /**
   * 零变更但执行过写操作的回合，也落一条轻记录（只有命令摘要，没有变更表）。
   * 关掉后这类回合完全不落盘——那既是省空间，也是彻底放弃“这轮动过别处”的线索。
   */
  recordQuietTurns: true,
  /**
   * 调用区间归因的容差（毫秒）。
   * 文件 mtime 与调用起止时间来自两个时钟（fs 与宿主事件），必然有几个 tick 的偏差，
   * 因此命中判定留一点余量；调大到 0 会让边界情况退回「时间窗内」。
   */
  intervalSlackMs: 1500,
};

const ROOT_ALIASES = {
  desktop: ['Desktop', 'OneDrive/Desktop', '桌面', 'OneDrive/桌面'],
  downloads: ['Downloads', '下载'],
  documents: ['Documents', '文档'],
  pictures: ['Pictures', '图片'],
  music: ['Music', '音乐'],
  videos: ['Videos', '视频'],
};

export function homeDir() {
  const env = process.env.USERPROFILE || process.env.HOME;
  if (typeof env === 'string' && env.trim()) return env.trim();
  try {
    return os.homedir();
  } catch {
    return 'C:\\Users\\Public';
  }
}

export function expandHome(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  if (!s) return '';
  s = s.replace(/^%USERPROFILE%/i, homeDir());
  s = s.replace(/^%HOMEDRIVE%%HOMEPATH%/i, homeDir());
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(homeDir(), s.slice(1));
  }
  return s;
}

function isDir(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function splitSpec(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const eq = trimmed.indexOf('=');
  if (eq > 0) {
    const id = trimmed.slice(0, eq).trim();
    const target = trimmed.slice(eq + 1).trim();
    if (id && target) return { id, target };
  }
  return { id: trimmed, target: trimmed };
}

/** 把一条 roots 条目解析成绝对目录；别名优先，解析不到就报 exists=false。 */
function resolveOne(spec) {
  const raw = expandHome(spec);
  if (!raw) return null;
  // 绝对路径优先
  if (path.isAbsolute(raw)) {
    const abs = path.win32.normalize(raw);
    return { id: basenameOf(abs), path: abs, requested: spec, exists: isDir(abs), via: 'path' };
  }
  const key = raw.toLowerCase();
  const aliases = ROOT_ALIASES[key];
  if (aliases) {
    for (const alias of aliases) {
      const abs = path.win32.normalize(path.join(homeDir(), alias));
      if (isDir(abs)) {
        return { id: key, path: abs, requested: spec, exists: true, via: `alias:${alias}` };
      }
    }
    const first = path.win32.normalize(path.join(homeDir(), aliases[0]));
    return { id: key, path: first, requested: spec, exists: false, via: `alias:${aliases[0]}` };
  }
  // 相对名：当作 home 下的子目录
  const abs = path.win32.normalize(path.join(homeDir(), raw));
  return { id: key, path: abs, requested: spec, exists: isDir(abs), via: 'home' };
}

function basenameOf(abs) {
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] || abs).toLowerCase();
}

export function resolveRoots(config) {
  const specs = [];
  for (const r of config.roots || []) specs.push(r);
  for (const r of config.extraRoots || []) specs.push(r);
  const seen = new Set();
  const out = [];
  for (const spec of specs) {
    const parsed = splitSpec(spec);
    if (!parsed) continue;
    const resolved = resolveOne(parsed.target);
    if (!resolved) continue;
    if (parsed.id && !/^[a-zA-Z]:/.test(parsed.id) && parsed.id !== resolved.id) {
      // `id=path` 形态，保留用户给的 id
      resolved.id = parsed.target === parsed.id ? resolved.id : parsed.id;
    }
    const key = resolved.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

export function normalizeConfig(input) {
  const cfg = { ...DEFAULTS };
  if (input && typeof input === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (input[key] !== undefined && input[key] !== null) cfg[key] = input[key];
    }
  }
  const clampInt = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  cfg.depth = clampInt(cfg.depth, 0, 6, DEFAULTS.depth);
  cfg.maxEntries = clampInt(cfg.maxEntries, 100, 200000, DEFAULTS.maxEntries);
  cfg.maxChangesPerReport = clampInt(cfg.maxChangesPerReport, 10, 5000, DEFAULTS.maxChangesPerReport);
  cfg.retentionDays = clampInt(cfg.retentionDays, 1, 90, DEFAULTS.retentionDays);
  cfg.intervalSlackMs = clampInt(cfg.intervalSlackMs, 0, 60000, DEFAULTS.intervalSlackMs);
  cfg.enabled = cfg.enabled !== false;
  cfg.maskHome = cfg.maskHome !== false;
  cfg.recordQuietTurns = cfg.recordQuietTurns !== false;
  if (!Array.isArray(cfg.roots)) cfg.roots = [...DEFAULTS.roots];
  if (!Array.isArray(cfg.extraRoots)) cfg.extraRoots = [];
  if (!Array.isArray(cfg.exclude)) cfg.exclude = [...DEFAULTS.exclude];
  cfg.roots = cfg.roots.filter((x) => typeof x === 'string' && x.trim());
  cfg.exclude = cfg.exclude.filter((x) => typeof x === 'string' && x.trim());
  return cfg;
}

export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim()) return path.win32.normalize(env.trim());
  return path.win32.normalize(path.join(homeDir(), '.dsh'));
}

export function stateDir() {
  return path.win32.normalize(path.join(dshHome(), 'state', 'aftermath'));
}
