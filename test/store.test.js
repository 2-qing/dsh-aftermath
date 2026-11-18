import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../lib/config.js';
import {
  appendTurn,
  readTurns,
  pruneTurns,
  writeReport,
  saveBaseline,
  loadBaseline,
  ensureDirs,
  turnsDir,
  dayKey,
} from '../lib/store.js';

function withTempHome(fn) {
  const original = process.env.DSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftermath-store-'));
  process.env.DSH_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureDirs 建出 turns 与 reports', () => {
  withTempHome((home) => {
    assert.equal(ensureDirs().ok, true);
    assert.ok(fs.existsSync(turnsDir()));
    assert.ok(fs.existsSync(path.join(home, 'state', 'aftermath', 'reports')));
  });
});

test('appendTurn / readTurns 往返，坏行被跳过', () => {
  withTempHome(() => {
    const at = Date.now();
    appendTurn({ v: 1, at, turn: 1, counts: { total: 2 } });
    appendTurn({ v: 1, at: at + 1, turn: 2, counts: { total: 0 } });
    const file = path.join(turnsDir(), `${dayKey(new Date(at))}.ndjson`);
    fs.appendFileSync(file, '{ 这不是 JSON\n', 'utf8');

    const all = readTurns({ limit: 10 });
    assert.equal(all.length, 2);
    assert.equal(all[0].turn, 2);
    assert.equal(all[1].turn, 1);
  });
});

test('readTurns 按 sinceMs 过滤', () => {
  withTempHome(() => {
    const now = Date.now();
    appendTurn({ v: 1, at: now - 60000, turn: 1 });
    appendTurn({ v: 1, at: now, turn: 2 });
    const recent = readTurns({ sinceMs: now - 1000, limit: 10 });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].turn, 2);
  });
});

test('pruneTurns 只删过期文件', () => {
  withTempHome(() => {
    ensureDirs();
    const old = new Date(Date.now() - 30 * 86400000);
    const oldName = `${dayKey(old)}.ndjson`;
    fs.writeFileSync(path.join(turnsDir(), oldName), '{"v":1,"at":1,"turn":1}\n', 'utf8');
    appendTurn({ v: 1, at: Date.now(), turn: 9 });
    const removed = pruneTurns(7);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(path.join(turnsDir(), oldName)), false);
    assert.equal(readTurns({ limit: 10 }).length, 1);
  });
});

test('writeReport 清理非法文件名字符', () => {
  withTempHome(() => {
    const file = writeReport('a/b:c*d', '# hi');
    assert.ok(file);
    assert.equal(path.basename(file), 'a_b_c_d.md');
    assert.match(fs.readFileSync(file, 'utf8'), /# hi/);
  });
});

test('baseline 往返；损坏文件返回 null', () => {
  withTempHome(() => {
    const baseline = { at: 123, roots: [{ id: 'desktop', path: 'C:\\D', ok: true, entries: [] }] };
    assert.equal(saveBaseline(baseline), true);
    assert.deepEqual(loadBaseline(), baseline);

    fs.writeFileSync(path.join(stateDir(), 'baseline.json'), '{ broken', 'utf8');
    assert.equal(loadBaseline(), null);
  });
});
