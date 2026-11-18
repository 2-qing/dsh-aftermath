import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRoot, pairMoves, diffSnapshotPair, toChangeList, indexEntries } from '../lib/diff.js';

const file = (rel, size, mtime) => ({ rel, dir: false, size, mtime });
const dir = (rel) => ({ rel, dir: true, size: 0, mtime: 0 });

test('diffRoot 报出新建/删除/修改，目录只比存在性', () => {
  const before = [dir('folder'), file('a.txt', 10, 1000), file('gone.txt', 5, 900)];
  const after = [dir('folder'), file('a.txt', 20, 2000), file('new.txt', 7, 3000)];

  const delta = diffRoot(before, after);
  assert.deepEqual(delta.created.map((e) => e.rel), ['new.txt']);
  assert.deepEqual(delta.deleted.map((e) => e.rel), ['gone.txt']);
  assert.equal(delta.modified.length, 1);
  assert.equal(delta.modified[0].rel, 'a.txt');
  assert.equal(delta.modified[0].before.size, 10);
  assert.equal(delta.modified[0].after.size, 20);
});

test('diffRoot 不把目录 mtime 变动当成修改', () => {
  const delta = diffRoot([dir('folder')], [dir('folder')]);
  assert.equal(delta.created.length, 0);
  assert.equal(delta.deleted.length, 0);
  assert.equal(delta.modified.length, 0);
});

test('pairMoves 只在同名同大小且 mtime 接近时配对', () => {
  const created = [file('b\\报告.docx', 2048, 5000), file('c\\other.txt', 1, 5000)];
  const deleted = [file('a\\报告.docx', 2048, 4000), file('d\\other.txt', 999, 4000)];

  const result = pairMoves(created, deleted);
  assert.equal(result.moved.length, 1);
  assert.equal(result.moved[0].from.rel, 'a\\报告.docx');
  assert.equal(result.moved[0].to.rel, 'b\\报告.docx');
  assert.equal(result.moved[0].heuristic, true);
  assert.equal(result.moved[0].mtimeDeltaMs, 1000);
  // 大小不同的那个不能配对，仍留在 created/deleted 里
  assert.deepEqual(result.created.map((e) => e.rel), ['c\\other.txt']);
  assert.deepEqual(result.deleted.map((e) => e.rel), ['d\\other.txt']);
});

test('pairMoves 拒绝 mtime 差过大的同名同大小条目', () => {
  const result = pairMoves([file('x\\a.bin', 100, 999999)], [file('y\\a.bin', 100, 1000)]);
  assert.equal(result.moved.length, 0);
  assert.equal(result.created.length, 1);
  assert.equal(result.deleted.length, 1);
});

test('diffSnapshotPair 任一侧不可读就整根跳过，绝不误判为全删', () => {
  const before = [{ id: 'desktop', root: 'C:\\U\\Desktop', ok: true, count: 2, entries: [file('a.txt', 1, 1), file('b.txt', 1, 1)] }];
  const after = [{ id: 'desktop', root: 'C:\\U\\Desktop', ok: false, error: 'missing-root', count: 0, entries: [] }];

  const delta = diffSnapshotPair(before, after);
  assert.equal(delta.deleted.length, 0);
  assert.equal(delta.created.length, 0);
  assert.equal(delta.skipped.length, 1);
  assert.equal(delta.skipped[0].reason, 'missing-root');
});

test('diffSnapshotPair 把移动合并进 modified 并保留 movedFrom', () => {
  const before = [{ id: 'desktop', root: 'C:\\U\\Desktop', ok: true, count: 1, entries: [file('a\\x.lnk', 100, 1000)] }];
  const after = [{ id: 'desktop', root: 'C:\\U\\Desktop', ok: true, count: 1, entries: [file('b\\x.lnk', 100, 1100)] }];

  const delta = diffSnapshotPair(before, after);
  const changes = toChangeList(delta);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'moved');
  assert.equal(changes[0].movedFrom, 'a\\x.lnk');
  assert.equal(changes[0].rel, 'b\\x.lnk');
  assert.equal(changes[0].heuristic, true);
});

test('toChangeList 产出稳定顺序：删除在前，新建在后', () => {
  const delta = {
    deleted: [{ rootId: 'desktop', root: 'C:\\D', rel: 'z.txt' }],
    created: [{ rootId: 'desktop', root: 'C:\\D', rel: 'a.txt', dir: false, size: 1, mtime: 1 }],
    modified: [],
  };
  const changes = toChangeList(delta);
  assert.deepEqual(changes.map((c) => `${c.kind}:${c.rel}`), ['deleted:z.txt', 'created:a.txt']);
});

test('indexEntries 以 rel 为键', () => {
  const map = indexEntries([file('a', 1, 1), file('b', 2, 2)]);
  assert.equal(map.size, 2);
  assert.equal(map.get('b').size, 2);
});
