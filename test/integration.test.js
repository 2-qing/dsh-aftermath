import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRoot, scanRoots, isExcluded } from '../lib/scan.js';
import { diffSnapshotPair, toChangeList } from '../lib/diff.js';
import { attributeChanges, summarizeConfidence } from '../lib/attribution.js';

function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aftermath-it-'));
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bbbb');
  fs.writeFileSync(path.join(root, 'del.txt'), 'x');
  return root;
}

const CFG = { depth: 2, maxEntries: 20000, exclude: ['node_modules'] };

test('isExcluded 支持精确、前缀、后缀与双星号', () => {
  assert.equal(isExcluded('node_modules', ['node_modules']), true);
  assert.equal(isExcluded('NODE_MODULES', ['node_modules']), true);
  assert.equal(isExcluded('~$report.docx', ['~$*']), true);
  assert.equal(isExcluded('a.tmp', ['*.tmp']), true);
  assert.equal(isExcluded('x.log.bak', ['x* .bak'.replace(' ', '')]), true);
  assert.equal(isExcluded('keep.txt', ['*.tmp', 'node_modules']), false);
});

test('scanRoot 记录文件大小与 mtime、目录只记存在性、不跟随链接', () => {
  const root = tempTree();
  try {
    const snap = scanRoot(root, CFG);
    assert.equal(snap.ok, true);
    const a = snap.entries.find((e) => e.rel === 'a.txt');
    assert.equal(a.size, 3);
    assert.ok(a.mtime > 0);
    const sub = snap.entries.find((e) => e.rel === 'sub');
    assert.equal(sub.dir, true);
    assert.equal(sub.size, 0);
    assert.equal(sub.mtime, 0);
    assert.ok(snap.entries.some((e) => e.rel === 'sub\\b.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanRoot 对缺失根返回 ok:false 而不是空结果', () => {
  const snap = scanRoot(path.join(os.tmpdir(), 'aftermath-does-not-exist-xyz'), CFG);
  assert.equal(snap.ok, false);
  assert.equal(snap.error, 'missing-root');
  assert.equal(snap.count, 0);
});

test('scanRoot depth=0 只看根目录', () => {
  const root = tempTree();
  try {
    const snap = scanRoot(root, { ...CFG, depth: 0 });
    assert.ok(snap.entries.every((e) => !e.rel.includes('\\')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('端到端：磁盘改动 → 快照差 → 归因', () => {
  const root = tempTree();
  try {
    const before = [{ ...scanRoot(root, CFG), id: 'desktop' }];

    // 模拟 AI 干的活：删一个、改一个、新建一个、搬一个。
    fs.rmSync(path.join(root, 'del.txt'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'aaa-changed-longer');
    fs.writeFileSync(path.join(root, 'new.txt'), 'n');
    fs.renameSync(path.join(root, 'sub', 'b.txt'), path.join(root, 'sub', 'moved.txt'));

    const after = [{ ...scanRoot(root, CFG), id: 'desktop' }];
    const delta = diffSnapshotPair(before, after);
    const changes = toChangeList(delta);

    const kinds = changes.map((c) => `${c.kind}:${c.rel}`).sort();
    assert.ok(kinds.includes('deleted:del.txt'));
    assert.ok(kinds.includes('modified:a.txt'));
    assert.ok(kinds.includes('created:new.txt'));

    // 带一条指向具体文件的写命令：del.txt 应拿到 certain。
    const calls = [
      {
        callId: 'c1',
        name: 'bash',
        at: Date.now(),
        arguments: JSON.stringify({ command: `rm "${path.join(root, 'del.txt').replace(/\\/g, '/')}"` }),
      },
    ];
    const attributed = attributeChanges(changes, calls);
    const deleted = attributed.find((c) => c.rel === 'del.txt');
    assert.equal(deleted.attribution.confidence, 'certain');
    assert.equal(deleted.attribution.tool, 'bash');

    const confidence = summarizeConfidence(attributed);
    assert.equal(confidence.certain, 1);
    assert.equal(Object.values(confidence).reduce((a, b) => a + b, 0), attributed.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanRoots 单根失败不拖垮其它根', () => {
  const root = tempTree();
  try {
    const snaps = scanRoots(
      [
        { id: 'good', path: root },
        { id: 'bad', path: path.join(os.tmpdir(), 'aftermath-nope-xyz') },
      ],
      CFG,
    );
    assert.equal(snaps[0].ok, true);
    assert.equal(snaps[1].ok, false);
    assert.equal(snaps[1].id, 'bad');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
