import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, Config } from '../lib/index.js';
import { readField, SCHEMA_SOURCE } from '../lib/schema.js';
import { readTurns } from '../lib/store.js';

/**
 * 一个最小化的 Volatile 引用：宿主里就是 config.field.get() 这种东西。
 * get() 必须读 this.value（而不是闭包变量），否则「改值」改不到。
 */
function ref(value) {
  return {
    value,
    get() {
      return this.value;
    },
  };
}

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

async function withEnv(fn) {
  const originalDsh = process.env.DSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftermath-live-'));
  process.env.DSH_HOME = path.join(dir, 'dsh-home');
  const desktop = path.join(dir, 'Desktop');
  const other = path.join(dir, 'Other');
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(desktop, 'a.txt'), 'a');
  fs.writeFileSync(path.join(other, 'b.txt'), 'b');
  try {
    return await fn({ dir, desktop, other });
  } finally {
    if (originalDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalDsh;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('readField：Volatile 引用取值，普通值原样返回', () => {
  assert.equal(readField({ depth: ref(3) }, 'depth'), 3);
  assert.equal(readField({ depth: 4 }, 'depth'), 4);
  assert.equal(readField({}, 'depth'), undefined);
  assert.equal(readField(null, 'depth'), undefined);
  assert.deepEqual(readField({ roots: ['desktop'] }, 'roots'), ['desktop']);
  // get() 抛异常时不能把插件带崩
  assert.equal(readField({ bad: { get() { throw new Error('boom'); } } }, 'bad'), undefined);
});

test('Config：拿不到 schemastery 时为 undefined，拿到时是对象', () => {
  // 字段级细节见 schema.test.js：这里只保证 index.js 的再导出与 schema 加载状态一致
  assert.equal(typeof Config, SCHEMA_SOURCE ? 'function' : 'undefined');
});

test('volatile 配置：关掉时不记，打开后同一进程内立即生效', async () => {
  await withEnv(async ({ desktop }) => {
    const enabled = ref(false);
    const roots = ref([desktop]);
    const depth = ref(0);
    const retentionDays = ref(7);
    const maskHome = ref(true);

    const host = fakeHost();
    apply(host.ctx, { enabled, roots, depth, retentionDays, maskHome });

    const session = { id: 'live-config' };

    // 第 1 轮：enabled=false，删文件也不应该留下记录
    host.emit(session, { type: 'turn/start', data: { turn: 1 }, time: Date.now() });
    fs.rmSync(path.join(desktop, 'a.txt'));
    host.emit(session, { type: 'turn/end', data: { turn: 1 }, time: Date.now() });
    assert.equal(readTurns({ limit: 10 }).length, 0, '关闭状态不应写记录');

    // 打开开关（模拟设置卡片里的写入），无需重启插件
    enabled.value = true;
    fs.writeFileSync(path.join(desktop, 'c.txt'), 'c');

    host.emit(session, { type: 'turn/start', data: { turn: 2 }, time: Date.now() });
    fs.rmSync(path.join(desktop, 'c.txt'));
    host.emit(session, { type: 'turn/end', data: { turn: 2 }, time: Date.now() });

    const records = readTurns({ limit: 10 });
    assert.equal(records.length, 1, '打开后应立即开始记录');
    const files = (records[0].changes || []).map((c) => c.rel.replace(/\\/g, '/'));
    assert.ok(files.includes('c.txt'), `应记录 c.txt，实际：${JSON.stringify(files)}`);
  });
});

test('volatile 配置：换观测根立即生效', async () => {
  await withEnv(async ({ desktop, other }) => {
    const roots = ref([desktop]);
    const host = fakeHost();
    apply(host.ctx, { enabled: ref(true), roots, depth: ref(0), retentionDays: ref(7), maskHome: ref(true) });

    const session = { id: 'live-roots' };
    host.emit(session, { type: 'turn/start', data: { turn: 1 }, time: Date.now() });
    fs.writeFileSync(path.join(desktop, 'd.txt'), 'd');
    host.emit(session, { type: 'turn/end', data: { turn: 1 }, time: Date.now() });

    // 换成另一个根，之后的变化应记在新根下
    roots.value = [other];
    host.emit(session, { type: 'turn/start', data: { turn: 2 }, time: Date.now() });
    fs.writeFileSync(path.join(other, 'e.txt'), 'e');
    host.emit(session, { type: 'turn/end', data: { turn: 2 }, time: Date.now() });

    const records = readTurns({ limit: 10 });
    const rels = records.flatMap((r) => (r.changes || []).map((c) => `${c.rootId}:${c.rel.replace(/\\/g, '/')}`));
    assert.ok(rels.some((x) => x.includes('d.txt')), `第一轮应记录 d.txt：${JSON.stringify(rels)}`);
    assert.ok(rels.some((x) => x.includes('e.txt')), `第二轮应把新根下的 e.txt 记进去：${JSON.stringify(rels)}`);
  });
});
