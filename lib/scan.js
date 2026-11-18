/**
 * 快照：把一个目录树压成 [{rel, dir, size, mtime}]。
 *
 * 设计取舍（追求精度与稳定，不追求吞吐）：
 * - 全同步 I/O。深度 2 的桌面约 0.3ms，同步换来“快照之间不可能交错”的确定性。
 * - 目录只记录存在性，不记录 size/mtime：目录 mtime 随子项增删变化，记了就是满屏噪音。
 * - 符号链接/junction 只记一条，不跟进去，避免环与越界。
 * - 单条目失败只计数，不抛：一次权限拒绝不该毁掉整轮观测。
 */
import fs from 'node:fs';
import path from 'node:path';

export function isExcluded(name, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const lower = name.toLowerCase();
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    const star = p.indexOf('*');
    if (star === 0) {
      if (lower.endsWith(p.slice(1))) return true;
    } else if (star === p.length - 1) {
      if (lower.startsWith(p.slice(0, -1))) return true;
    } else if (p.includes('*')) {
      const [head, tail] = [p.slice(0, star), p.slice(star + 1)];
      if (lower.startsWith(head) && lower.endsWith(tail)) return true;
    } else if (lower === p) {
      return true;
    }
  }
  return false;
}

/**
 * @returns {{ok:boolean,complete:boolean,error:string|null,root:string,entries:Array,count:number,ms:number,truncated:boolean,unreadable:number,links:number}}
 */
export function scanRoot(rootPath, options = {}) {
  const depth = Number.isInteger(options.depth) ? options.depth : 2;
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 20000;
  const exclude = Array.isArray(options.exclude) ? options.exclude : [];
  const started = Date.now();
  const state = { entries: [], truncated: false, unreadable: 0, links: 0 };
  let ok = true;
  let error = null;

  // 根目录自身必须可读，否则视为本次扫描失败（绝不把“读不到”当成“都删了”）。
  try {
    const st = fs.statSync(rootPath, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) {
      return {
        ok: false,
        complete: false,
        error: st ? 'not-a-directory' : 'missing-root',
        root: rootPath,
        entries: [],
        count: 0,
        ms: Date.now() - started,
        truncated: false,
        unreadable: 0,
        links: 0,
      };
    }
  } catch (err) {
    return {
      ok: false,
      complete: false,
      error: `root-unreadable:${err?.code || 'error'}`,
      root: rootPath,
      entries: [],
      count: 0,
      ms: Date.now() - started,
      truncated: false,
      unreadable: 0,
      links: 0,
    };
  }

  const walk = (absDir, relDir, level) => {
    if (state.truncated) return;
    let dirents;
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (level === 0) {
        ok = false;
        error = `readdir-failed:${err?.code || 'error'}`;
      } else {
        state.unreadable += 1;
      }
      return;
    }
    for (const dirent of dirents) {
      if (state.entries.length >= maxEntries) {
        state.truncated = true;
        return;
      }
      const name = dirent.name;
      if (isExcluded(name, exclude)) continue;
      const rel = relDir ? `${relDir}\\${name}` : name;
      const abs = path.join(absDir, name);

      let isLink = false;
      let isDir = false;
      try {
        isLink = dirent.isSymbolicLink();
        isDir = dirent.isDirectory();
      } catch {
        state.unreadable += 1;
        continue;
      }

      if (isLink) {
        state.links += 1;
        state.entries.push({ rel, dir: false, size: -1, mtime: 0, link: true });
        continue;
      }

      if (isDir) {
        state.entries.push({ rel, dir: true, size: 0, mtime: 0 });
        if (level < depth) walk(abs, rel, level + 1);
        continue;
      }

      let st = null;
      try {
        st = fs.statSync(abs, { throwIfNoEntry: false });
      } catch {
        st = null;
      }
      if (!st) {
        state.unreadable += 1;
        state.entries.push({ rel, dir: false, size: -1, mtime: 0, missing: true });
        continue;
      }
      state.entries.push({
        rel,
        dir: false,
        size: st.size,
        mtime: Math.round(Number(st.mtimeMs) || 0),
      });
    }
  };

  walk(rootPath, '', 0);

  return {
    ok,
    // complete = 这份名单可以拿来跟上一份比。截断或任何子目录读不到都不算完整：
    // 名单不全时做差，会把"没扫到"误报成"被删除"。
    complete: ok && !state.truncated && state.unreadable === 0,
    error,
    root: rootPath,
    entries: state.entries,
    count: state.entries.length,
    ms: Date.now() - started,
    truncated: state.truncated,
    unreadable: state.unreadable,
    links: state.links,
  };
}

/** 扫描一组已解析的根；单个根失败不影响其它根。 */
export function scanRoots(roots, config) {
  const out = [];
  for (const root of roots) {
    const snap = scanRoot(root.path, {
      // 根可以自带宽深（cwd 这种大目录只用顶层）
      depth: Number.isInteger(root.depth) ? root.depth : config.depth,
      maxEntries: config.maxEntries,
      exclude: config.exclude,
    });
    out.push({ ...snap, id: root.id });
  }
  return out;
}

export function absOf(rootPath, rel) {
  return path.win32.normalize(path.join(rootPath, rel));
}

export function extOf(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx).toLowerCase();
}
