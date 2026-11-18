import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../lib/index.js';
import { readTurns } from '../lib/store.js';

/** 最小化的宿主替身：只实现本插件用到的四个面。 */
function fakeHost() {
  const handlers = new Map();
  const tools = [];
  const commands = [];
  const logs = [];
  const ctx = {
    on(type, fn) {
      handlers.set(type, fn);
      return () => handlers.delete(type);
    },
    inject(services, callback) {
      if (Array.isArray(services) && services.includes('commands')) {
        callback({
          get(service) {
            return service === 'commands' ? { register: (definition) => commands.push(definition) } : undefined;
          },
        });
      }
    },
    tools: { register: (tool) => tools.push(tool) },
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
  };
  return {
    ctx,
    tools,
    commands,
    logs,
    emit(session, event) {
      const handler = handlers.get('session/event');
      assert.ok(handler, 'session/event 未订阅');
      handler(session, event);
    },
    hasHandler: () => handlers.has('session/event'),
  };
}

async function withEnv(fn) {
  const originalDsh = process.env.DSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftermath-plugin-'));
  process.env.DSH_HOME = path.join(dir, 'dsh-home');
  const root = path.join(dir, 'Desktop');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(root, 'gone.txt'), 'g');
  try {
    return await fn({ dir, root });
  } finally {
    if (originalDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalDsh;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('导出契约：name / inject 符合插件规范', () => {
  assert.equal(name, 'dsh-aftermath');
  assert.deepEqual(inject, ['tools']);
});

test('一轮完整闭环：turn/start → tool/call → turn/end 落盘并归因', () => {
  withEnv(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], depth: 2, maskHome: false });
    assert.equal(host.hasHandler(), true);
    assert.equal(host.tools.length, 1);
    assert.equal(host.tools[0].name, 'aftermath_history');
    assert.equal(host.commands.length, 1);
    assert.equal(host.commands[0].name, 'aftermath');

    const session = { id: 'sess-1' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 1 } });

    const target = path.join(root, 'gone.txt');
    host.emit(session, {
      type: 'tool/call',
      time: Date.now(),
      data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: `rm "${target.replace(/\\/g, '/')}"` }) },
    });

    fs.rmSync(target);
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 1 } });

    const records = readTurns({ limit: 5 });
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.turn, 1);
    assert.equal(record.counts.deleted, 1);
    assert.equal(record.counts.total, 1);
    const change = record.changes[0];
    assert.equal(change.rel, 'gone.txt');
    assert.equal(change.kind, 'deleted');
    assert.equal(change.attribution.confidence, 'certain');
    assert.equal(change.attribution.tool, 'bash');
    assert.equal(record.calls.length, 1);
    assert.equal(record.calls[0].name, 'bash');
  });
});

test('没有变更的轮次不写记录，避免噪音', () => {
  withEnv(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-2' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 1 } });
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 1 } });
    assert.equal(readTurns({ limit: 5 }).length, 0);
  });
});

test('没有 turn/start 的 turn/end 直接跳过（宁可漏记也不错记）', () => {
  withEnv(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-3' };
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 1 } });
    assert.equal(readTurns({ limit: 5 }).length, 0);
  });
});

test('事件处理里的异常不外抛', () => {
  withEnv(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-4' };
    assert.doesNotThrow(() => host.emit(session, { type: 'tool/call', data: null }));
    assert.doesNotThrow(() => host.emit(session, { type: 'unknown/type' }));
    assert.doesNotThrow(() => host.emit(session, { type: 'turn/start', data: { turn: 2 } }));
  });
});

test('命令与工具都能读到刚写入的记录', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-5' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 3 } });
    fs.writeFileSync(path.join(root, 'new.txt'), 'n');
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 3 } });

    const command = host.commands[0];
    const reply = command.handler({ rawInput: 'report --last 1' });
    return Promise.resolve(reply).then(async (result) => {
      assert.equal(typeof result.text, 'string');
      assert.match(result.text, /new\.txt/);
      assert.match(result.text, /本轮|共 /);

      const tool = host.tools[0];
      const value = await tool.execute({ limit: 1 });
      assert.match(value.text, /new\.txt/);
      const rendered = tool.output.render({}, value);
      assert.equal(rendered[0].type, 'text');
      assert.match(rendered[0].text, /new\.txt/);
    });
  });
});

test('未知子命令返回 error 而不是抛错', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const result = await host.commands[0].handler({ rawInput: 'nope' });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /不认识子命令/);
  });
});

test('status / roots 子命令可用', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false });
    const command = host.commands[0];
    const status = await command.handler({ rawInput: 'status' });
    assert.match(status.text, /dsh-aftermath/);
    const roots = await command.handler({ rawInput: 'roots' });
    assert.match(roots.text, /观测根/);
    assert.match(roots.text, /state/);
  });
});
