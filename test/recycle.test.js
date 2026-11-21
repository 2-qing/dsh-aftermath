import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseIEntry, scanRecycleBin, annotateDeletions } from '../lib/recycle.js';

const FILETIME_OFFSET_MS = 11644473600000n;

function filetimeOf(ms) {
  return (BigInt(ms) + FILETIME_OFFSET_MS) * 10000n;
}

function makeIEntry(originalPath, size, deletedAtMs) {
  const pathBuf = Buffer.from(originalPath, 'utf16le');
  const buf = Buffer.alloc(28 + pathBuf.length);
  buf.writeBigUInt64LE(2n, 0); // version
  buf.writeBigUInt64LE(BigInt(size), 8);
  buf.writeBigUInt64LE(filetimeOf(deletedAtMs), 16);
  buf.writeUInt32LE(originalPath.length, 24); // 字符数，非字节数
  pathBuf.copy(buf, 28);
  return buf;
}

function tempIEntry(fileName, originalPath, size, deletedAtMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-recycle-'));
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, makeIEntry(originalPath, size, deletedAtMs));
  return { full, dir, originalPath, size, deletedAtMs };
}

test('parseIEntry 解析 $I 元数据：大小/原路径/删除时刻', () => {
  const deletedAtMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { full, dir, originalPath, size } = tempIEntry('$IABC01', 'C:\\Users\\u\\Desktop\\a.txt', 42, deletedAtMs);
  try {
    const parsed = parseIEntry(full, '$IABC01');
    assert.ok(parsed);
    assert.equal(parsed.size, 42);
    assert.equal(parsed.id, 'ABC01');
    assert.equal(parsed.originalPath, originalPath);
    assert.equal(parsed.deletedAtMs, deletedAtMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('annotateDeletions：三重匹配标 restorable，大小或路径不符标 not-in-recycle', () => {
  const deletedAtMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const startedAt = deletedAtMs - 1000;
  const endedAt = deletedAtMs + 1000;
  const original = 'C:\\Users\\u\\Desktop\\a.txt';

  const scan = {
    readable: true,
    entries: [
      {
        file: 'C:\\$Recycle.Bin\\S-1-5-21\\$IABC01',
        name: '$IABC01',
        id: 'ABC01',
        version: 2,
        size: 42,
        deletedAtMs,
        originalPath: original,
        normalizedPath: original.toLowerCase().replace(/[\\/]+/g, '/'),
      },
    ],
  };

  // 匹配：路径 + 大小 + 时间都对
  const matched = {
    startedAt, at: endedAt,
    changes: [{ kind: 'deleted', rel: 'a.txt', root: 'C:\\Users\\u\\Desktop', abs: original, before: { size: 42 } }],
  };
  annotateDeletions(matched, scan);
  assert.equal(matched.changes[0].recycle.status, 'restorable');
  assert.equal(matched.changes[0].recycle.deletedAt, deletedAtMs);

  // 大小不符 → not-in-recycle
  const wrongSize = {
    startedAt, at: endedAt,
    changes: [{ kind: 'deleted', rel: 'a.txt', root: 'C:\\Users\\u\\Desktop', abs: original, before: { size: 99 } }],
  };
  annotateDeletions(wrongSize, scan);
  assert.equal(wrongSize.changes[0].recycle.status, 'not-in-recycle');

  // 路径不符 → not-in-recycle
  const wrongPath = {
    startedAt, at: endedAt,
    changes: [{ kind: 'deleted', rel: 'b.txt', root: 'C:\\Users\\u\\Desktop', abs: 'C:\\Users\\u\\Desktop\\b.txt', before: { size: 42 } }],
  };
  annotateDeletions(wrongPath, scan);
  assert.equal(wrongPath.changes[0].recycle.status, 'not-in-recycle');
});

test('annotateDeletions：回收站读不到标 unknown，只读删除不碰其它', () => {
  const record = {
    startedAt: Date.now() - 2000,
    at: Date.now(),
    changes: [
      { kind: 'deleted', rel: 'a.txt', root: 'C:\\Users\\u\\Desktop', abs: 'C:\\Users\\u\\Desktop\\a.txt', before: { size: 1 } },
      { kind: 'created', rel: 'b.txt' },
    ],
  };
  annotateDeletions(record, { readable: false, entries: [] });
  assert.equal(record.changes[0].recycle.status, 'unknown');
  assert.equal(record.changes[1].recycle, undefined);
});

test('scanRecycleBin：目录不存在返回 readable:false', () => {
  const result = scanRecycleBin(path.join(os.tmpdir(), 'am-no-such-recycle-dir'));
  assert.equal(result.readable, false);
  assert.deepEqual(result.entries, []);
});