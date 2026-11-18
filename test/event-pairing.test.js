import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { readTurns } from '../lib/store.js';

/** 最小宿主替身：只要 on / inject / tools / logger。 */
function fakeHost() {
  const handlers = new Map();
  const ctx = {
    on(type, fn) {
      handlers.set(type, fn);
      return () => handlers.delete(type);
    },
    inject() {},
    tools: { register() {} },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  };
  return {
    ctx,
    emit(session, event) {
      const handler = handlers.get('session/event');
      assert.ok(handler, 'session/event 未订阅');
      handler(session, event);
    },
  };
}

async function withRoot(fn) {
  const original = process.env.DSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftermath-pair-'));
  process.env.DSH_HOME = path.join(dir, 'dsh-home');
  const root = path.join(dir, 'Desktop');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'keep.txt'), 'k');
  try {
    return await fn({ root });
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const noise = JSON.stringify({ command: 'npm run build' });

test('tool/result 按 step 配对，给调用补上结束时刻并进入健康度', async () => {
  await withRoot(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false, intervalSlackMs: 500 });
    const session = { id: 'sess-pair' };
    host.emit(session, { type: 'turn/start', time: 1000, data: { turn: 1 } });
    host.emit(session, { type: 'tool/call', time: 2000, data: { callId: 'c1', name: 'bash', arguments: noise, step: 1 } });
    host.emit(session, { type: 'tool/call', time: 3000, data: { callId: 'c2', name: 'bash', arguments: noise, step: 1 } });
    host.emit(session, { type: 'tool/result', time: 2600, data: { turn: 1, step: 1 } });
    host.emit(session, { type: 'tool/result', time: 4200, data: { turn: 1, step: 1 } });

    // 造一处真实变更，否则本轮不写记录
    fs.writeFileSync(path.join(root, 'new.txt'), 'n');
    host.emit(session, { type: 'turn/end', time: 5000, data: { turn: 1 } });

    const records = readTurns({ limit: 3 });
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.calls.length, 2);
    assert.equal(record.calls[0].at, 2000);
    assert.equal(record.calls[0].endAt, 2600, '先发起的调用先拿到结果');
    assert.equal(record.calls[1].at, 3000);
    assert.equal(record.calls[1].endAt, 4200);

    const health = record.health;
    assert.ok(health, '记录里应带 health');
    assert.equal(health.intervals.calls, 2);
    assert.equal(health.intervals.mutating, 2);
    assert.equal(health.intervals.timed, 2);
    assert.equal(health.intervals.closed, 2);
    assert.equal(health.intervals.slackMs, 500);
    assert.equal(health.truncated, false);
    assert.ok(Number.isFinite(health.scanMs));
    assert.equal(health.changes === undefined ? health.changed : health.changes, 1);
  });
});

test('没有 tool/result 时调用保持未封口，健康度如实显示', async () => {
  await withRoot(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-open' };
    host.emit(session, { type: 'turn/start', time: 1000, data: { turn: 2 } });
    host.emit(session, { type: 'tool/call', time: 2000, data: { callId: 'c1', name: 'bash', arguments: noise, step: 1 } });
    fs.writeFileSync(path.join(root, 'another.txt'), 'n');
    host.emit(session, { type: 'turn/end', time: 5000, data: { turn: 2 } });

    const record = readTurns({ limit: 3 })[0];
    assert.equal(record.calls[0].endAt, null);
    assert.equal(record.health.intervals.closed, 0);
    assert.equal(record.health.intervals.timed, 1);
  });
});

test('tool/result 在没有对应调用时被安静忽略', async () => {
  await withRoot(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-orphan' };
    host.emit(session, { type: 'turn/start', time: 1000, data: { turn: 3 } });
    assert.doesNotThrow(() => host.emit(session, { type: 'tool/result', time: 2000, data: { turn: 3, step: 1 } }));
    assert.doesNotThrow(() => host.emit(session, { type: 'tool/result', time: 2100, data: null }));
    host.emit(session, { type: 'turn/end', time: 5000, data: { turn: 3 } });
  });
});
test('并行调用乱序回来时按 callId 配对，不会把结束时刻挂错', async () => {
  await withRoot(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-parallel' };
    host.emit(session, { type: 'turn/start', time: 1000, data: { turn: 4 } });
    host.emit(session, { type: 'tool/call', time: 2000, data: { callId: 'slow', name: 'bash', arguments: noise, step: 7 } });
    host.emit(session, { type: 'tool/call', time: 2100, data: { callId: 'fast', name: 'bash', arguments: noise, step: 7 } });
    // fast 先回来
    host.emit(session, { type: 'tool/result', time: 2200, data: { turn: 4, step: 7, callId: 'fast' } });
    host.emit(session, { type: 'tool/result', time: 6000, data: { turn: 4, step: 7, callId: 'slow' } });
    fs.writeFileSync(path.join(root, 'parallel.txt'), 'p');
    host.emit(session, { type: 'turn/end', time: 7000, data: { turn: 4 } });

    const records = readTurns({ limit: 3 });
    const record = records[0];
    const byCall = new Map(record.calls.map((call) => [call.name + '@' + call.at, call]));
    const slow = record.calls.find((call) => call.at === 2000);
    const fast = record.calls.find((call) => call.at === 2100);
    assert.equal(fast.endAt, 2200, '先回来的那条对上了自己的结束时刻');
    assert.equal(slow.endAt, 6000);
    assert.equal(record.health.ambiguousResults, 0, 'callId 能唯一确定时不该记歧义');
    assert.ok(byCall.size >= 1);
  });
});

test('并行又拿不到 callId 时记歧义，不假装配对成功', async () => {
  await withRoot(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-ambiguous' };
    host.emit(session, { type: 'turn/start', time: 1000, data: { turn: 5 } });
    host.emit(session, { type: 'tool/call', time: 2000, data: { callId: 'a', name: 'bash', arguments: noise, step: 2 } });
    host.emit(session, { type: 'tool/call', time: 2001, data: { callId: 'b', name: 'bash', arguments: noise, step: 2 } });
    host.emit(session, { type: 'tool/result', time: 3000, data: { turn: 5 } });
    fs.writeFileSync(path.join(root, 'ambiguous.txt'), 'a');
    host.emit(session, { type: 'turn/end', time: 4000, data: { turn: 5 } });

    const record = readTurns({ limit: 3 })[0];
    assert.equal(record.health.ambiguousResults, 1);
  });
});
