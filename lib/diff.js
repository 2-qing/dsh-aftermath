/**
 * 快照比较。纯函数，无 I/O，可单测。
 *
 * 语义边界：
 * - `moved` 永远是启发式（同名 + 同大小 + mtime 相近），带 heuristic 标记，
 *   报告里必须与 `deleted` 分开说，绝不合并成“被移动”这种断言。
 * - mtime 变动严格比较：NTFS 是 100ns 分辨率，JS 侧已取整到 ms，不存在浮点噪音。
 */

const MOVE_MTIME_TOLERANCE_MS = 2000;

export function indexEntries(entries) {
  const map = new Map();
  for (const entry of entries || []) map.set(entry.rel, entry);
  return map;
}

export function diffRoot(beforeEntries, afterEntries) {
  const before = indexEntries(beforeEntries);
  const after = indexEntries(afterEntries);

  const created = [];
  const deleted = [];
  const modified = [];

  for (const [rel, entry] of after) {
    const old = before.get(rel);
    if (!old) {
      created.push(entry);
      continue;
    }
    // 类型互换（文件 ↔ 目录）：当"改写"报出来，不当没发生
    if (entry.dir !== old.dir) {
      modified.push({ rel, before: old, after: entry, typeChanged: true });
      continue;
    }
    if (entry.dir || old.dir) continue; // 目录只看存在性
    if (old.missing || entry.missing) continue;
    if (entry.link || old.link) continue;
    if (entry.size !== old.size || entry.mtime !== old.mtime) {
      modified.push({ rel, before: old, after: entry });
    }
  }

  for (const [rel, entry] of before) {
    if (!after.has(rel)) deleted.push(entry);
  }

  return { created, deleted, modified };
}

function basenameOf(rel) {
  const idx = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'));
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

/**
 * 把 {created, deleted} 里能配成一对的合成 moved。
 * 只在同名 + 同大小 + mtime 差 ≤ 2s 时配对，剩余的原样保留。
 */
export function pairMoves(created, deleted) {
  const moved = [];
  const usedCreated = new Set();
  const usedDeleted = new Set();
  const byName = new Map();

  for (let i = 0; i < created.length; i += 1) {
    const entry = created[i];
    if (entry.dir || entry.missing || entry.link) continue;
    const name = basenameOf(entry.rel).toLowerCase();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(i);
  }

  for (let d = 0; d < deleted.length; d += 1) {
    const gone = deleted[d];
    if (gone.dir || gone.missing || gone.link) continue;
    const name = basenameOf(gone.rel).toLowerCase();
    const candidates = byName.get(name);
    if (!candidates || candidates.length === 0) continue;
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (const idx of candidates) {
      if (usedCreated.has(idx)) continue;
      const added = created[idx];
      if (added.size !== gone.size) continue;
      const delta = Math.abs((added.mtime || 0) - (gone.mtime || 0));
      if (delta <= MOVE_MTIME_TOLERANCE_MS && delta < bestDelta) {
        bestDelta = delta;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) continue;
    usedCreated.add(bestIdx);
    usedDeleted.add(d);
    moved.push({
      from: gone,
      to: created[bestIdx],
      heuristic: true,
      mtimeDeltaMs: bestDelta,
    });
  }

  return {
    moved,
    created: created.filter((_, idx) => !usedCreated.has(idx)),
    deleted: deleted.filter((_, idx) => !usedDeleted.has(idx)),
  };
}

/**
 * 一轮的完整变更集：{created, deleted, modified, moved}，每项已带 rootId。
 */
/** 根的身份 = id + 规范化路径。只按 id 会把 C:\A\Desktop 和 D:\B\Desktop 互相比对。 */
function rootKey(snap) {
  const id = String(snap?.id ?? '');
  const path = String(snap?.root ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return `${id}|${path}`;
}

function incompleteReason(snap) {
  if (snap.ok === false) return snap.error || 'unreadable';
  if (snap.truncated) return 'truncated';
  if (Number(snap.unreadable) > 0) return 'unreadable-subdir';
  if (snap.complete === false) return 'incomplete';
  return null;
}

export function diffSnapshotPair(beforeSnaps, afterSnaps) {
  const beforeByRoot = new Map();
  const beforeById = new Map();
  for (const snap of beforeSnaps || []) {
    beforeByRoot.set(rootKey(snap), snap);
    const id = String(snap?.id ?? '');
    if (!beforeById.has(id)) beforeById.set(id, []);
    beforeById.get(id).push(snap);
  }

  const created = [];
  const deleted = [];
  const modified = [];
  const roots = [];
  const skipped = [];

  for (const after of afterSnaps || []) {
    const key = rootKey(after);
    const before = beforeByRoot.get(key);
    roots.push({
      id: after.id,
      path: after.root,
      ok: after.ok,
      complete: after.complete !== false,
      count: after.count,
      truncated: after.truncated === true,
      unreadable: Number(after.unreadable) || 0,
    });

    if (!after.ok || !before || !before.ok) {
      // 任一侧不可信就整根跳过：读不到 ≠ 全被删。
      const reason = !after.ok
        ? after.error || 'unreadable'
        : before
          ? before.error || 'unreadable'
          : beforeById.has(String(after.id ?? '')) ? 'root-changed' : 'no-before';
      skipped.push({ id: after.id, path: after.root, reason });
      continue;
    }

    // 名单不全（截断 / 有子目录读不到）时做差会把"没扫到"说成"被删除"，
    // 所以整根跳过并写明原因，宁可少报也不误报。
    const incomplete = incompleteReason(after) || incompleteReason(before);
    if (incomplete) {
      skipped.push({ id: after.id, path: after.root, reason: incomplete });
      continue;
    }

    const delta = diffRoot(before.entries, after.entries);
    const paired = pairMoves(delta.created, delta.deleted);

    for (const entry of delta.modified) {
      modified.push({ rel: entry.rel, before: entry.before, after: entry.after, rootId: after.id, root: after.root });
    }
    for (const entry of paired.created) {
      created.push({ ...entry, rootId: after.id, root: after.root });
    }
    for (const entry of paired.deleted) {
      deleted.push({ ...entry, rootId: after.id, root: after.root });
    }
    for (const m of paired.moved) {
      modified.push({
        rel: m.to.rel,
        before: m.from,
        after: m.to,
        rootId: after.id,
        root: after.root,
        movedFrom: m.from.rel,
        heuristic: true,
        mtimeDeltaMs: m.mtimeDeltaMs,
      });
    }
  }

  return { created, deleted, modified, roots, skipped };
}

export function toChangeList(delta) {
  const changes = [];
  for (const entry of delta.deleted) {
    changes.push({ kind: 'deleted', rootId: entry.rootId, root: entry.root, rel: entry.rel, before: entry, after: null });
  }
  for (const entry of delta.created) {
    changes.push({ kind: 'created', rootId: entry.rootId, root: entry.root, rel: entry.rel, before: null, after: entry });
  }
  for (const entry of delta.modified) {
    const kind = entry.movedFrom ? 'moved' : 'modified';
    changes.push({
      kind,
      rootId: entry.rootId,
      root: entry.root,
      rel: entry.rel,
      before: entry.before,
      after: entry.after,
      heuristic: entry.heuristic === true,
      movedFrom: entry.movedFrom || null,
    });
  }
  return changes;
}
