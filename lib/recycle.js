// 回收站可恢复标注（A1）。
//
// Windows 把删除的文件搬进 `$Recycle.Bin\<SID>\`，其中 `$I<id>` 是元数据
// （版本/大小/删除时刻/原路径，UTF-16LE），`$R<id>` 是实际数据。`$I*` 免提权可读，
// 所以只需要 fs:read 就能判断「被删的文件还在不在回收站、能不能恢复」，
// 不碰 `$R` 大文件，也不做任何写入或恢复动作。

import fs from 'node:fs';
import path from 'node:path';

// FILETIME：自 1601-01-01 起、每 100 ns 一格的计数，转 Unix 毫秒要扣掉这个偏移。
const FILETIME_TO_UNIX_MS = 11644473600000n;
// 删除发生时刻允许比回合开始早一点（一轮检测是前后快照之差，删除可能发生在上一个动作）。
const WINDOW_BEFORE_MS = 5000;
const WINDOW_AFTER_MS = 2000;

function normalizeForCompare(value) {
  return String(value || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function filetimeToMs(filetime) {
  if (typeof filetime !== 'bigint' || filetime === 0n) return null;
  return Number((filetime / 10000n) - FILETIME_TO_UNIX_MS);
}

/** 回收站根目录：优先系统盘，退化到 cwd 所在盘。 */
export function recycleBinDir() {
  const drive = path.parse(process.env.SystemDrive || process.cwd() || 'C:\\').root || 'C:\\';
  return path.join(drive, '$Recycle.Bin');
}

/** 解析一个 `$I` 元数据文件；读不全或不是合法结构时返回 null。 */
export function parseIEntry(fullPath, name) {
  let buf;
  try {
    buf = fs.readFileSync(fullPath);
  } catch {
    return null;
  }
  if (!buf || buf.length < 28) return null;
  const version = buf.readBigUInt64LE(0);
  const size = buf.readBigUInt64LE(8);
  const filetime = buf.readBigUInt64LE(16);
  const pathLen = buf.readUInt32LE(24);
  const pathBytes = pathLen * 2;
  if (!Number.isInteger(pathLen) || pathLen <= 0 || buf.length < 28 + pathBytes) return null;
  const originalPath = buf.toString('utf16le', 28, 28 + pathBytes).replace(/\0+$/u, '');
  if (!originalPath) return null;
  return {
    file: fullPath,
    name,
    id: name.startsWith('$I') ? name.slice(2) : name,
    version: Number(version),
    size: Number(size),
    deletedAtMs: filetimeToMs(filetime),
    originalPath,
    normalizedPath: normalizeForCompare(originalPath),
  };
}

/** 遍历所有 SID 子目录里的 `$I*`，返回 { readable, entries }。 */
export function scanRecycleBin(dir = recycleBinDir()) {
  const entries = [];
  let sids;
  try {
    sids = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { readable: false, entries };
  }
  for (const sidDir of sids) {
    if (!sidDir || !sidDir.isDirectory()) continue;
    const sidPath = path.join(dir, sidDir.name);
    let names;
    try {
      names = fs.readdirSync(sidPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (typeof name !== 'string' || !name.startsWith('$I')) continue;
      const parsed = parseIEntry(path.join(sidPath, name), name);
      if (parsed) entries.push(parsed);
    }
  }
  return { readable: true, entries };
}

/**
 * 给 record.changes 里每条「删除」加三段式标注 recycle：
 *  - restorable       路径 + 大小 + 删除时刻三重匹配 → 文件还在回收站，可从回收站窗口恢复
 *  - not-in-recycle   回收站扫过了，但没有任何一条能三重匹配（很可能已永久删除或清空）
 *  - unknown          回收站读不到，无法判定
 * 只 fs:read、不做恢复；外部可以传一份已扫描的结果避免重复读盘（测试也用它）。
 */
export function annotateDeletions(record, scan = null) {
  const changes = Array.isArray(record?.changes) ? record.changes : [];
  const deletions = changes.filter((change) => change?.kind === 'deleted');
  if (deletions.length === 0) return;

  const result = scan || scanRecycleBin();
  if (!result || result.readable !== true) {
    for (const del of deletions) del.recycle = { status: 'unknown' };
    return;
  }

  const startedAt = Number.isFinite(record?.startedAt) ? record.startedAt : null;
  const endedAt = Number.isFinite(record?.at) ? record.at : null;

  for (const del of deletions) {
    const abs = normalizeForCompare(
      del.abs || (del.root && del.rel ? `${del.root}\\${del.rel}` : del.rel || ''),
    );
    const size = Number.isFinite(del?.before?.size) ? del.before.size : null;

    let match = null;
    for (const entry of result.entries) {
      if (abs && entry.normalizedPath !== abs) continue;
      if (size !== null && entry.size !== size) continue;
      if (startedAt !== null && endedAt !== null && entry.deletedAtMs !== null) {
        const inWindow = entry.deletedAtMs >= startedAt - WINDOW_BEFORE_MS
          && entry.deletedAtMs <= endedAt + WINDOW_AFTER_MS;
        if (!inWindow) continue;
      }
      match = entry;
      break;
    }

    if (match) {
      del.recycle = { status: 'restorable', deletedAt: match.deletedAtMs, recyclePath: match.file };
    } else {
      del.recycle = { status: 'not-in-recycle' };
    }
  }
}