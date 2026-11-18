import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../lib/index.js';
import { readTurns } from '../lib/store.js';
import { stateDir } from '../lib/config.js';

/** 最小化的宿主替身：只实现本插件用到的四个面。 */
function fakeHost() {
  const handlers = new Map();
  const tools = [];
  const commands = [];
  const logs = [];
  const settings = { describe: () => [] };
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; } };
  const ctx = {
    on(type, fn) {
      handlers.set(type, fn);
      return () => handlers.delete(type);
    },
    inject(services, callback) {
      if (!Array.isArray(services)) return;
      if (services.includes('commands')) {
        callback({
          get(service) {
            return service === 'commands' ? { register: (definition) => commands.push(definition) } : undefined;
          },
        });
      }
      if (services.includes('settings')) {
        callback({
          get(service) {
            return service === 'settings' ? settings : undefined;
          },
        });
      }
      if (services.includes('webServer') && webServer) {
        callback({
          get(service) {
            return service === 'webServer' ? webServer : undefined;
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
    settings,
    routes,
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

test('启动自检：命名空间与字段名取自 describe 的 value，写进 settings-probe.json', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    host.settings.describe = () => [
      { ns: 'dsh-aftermath', value: { enabled: true, depth: 2 } },
      { ns: 'web', value: {}, schema: { uid: 7, refs: { 7: { properties: { a: {}, b: {} } } } } },
    ];
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false });
    const probe = JSON.parse(fs.readFileSync(path.join(stateDir(), 'settings-probe.json'), 'utf8'));
    assert.equal(probe.ourNamespace, true);
    const ours = probe.namespaces.find((row) => row.ns === 'dsh-aftermath');
    assert.deepEqual(ours.fields, ['enabled', 'depth']);
    const web = probe.namespaces.find((row) => row.ns === 'web');
    assert.deepEqual(web.fields, ['a', 'b']);
    assert.equal(probe.error, null);
  });
});

test('启动自检：命名空间缺失时记录原因，不抛异常', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    host.settings.describe = () => [{ ns: 'other', value: { x: 1 } }];
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false });
    const probe = JSON.parse(fs.readFileSync(path.join(stateDir(), 'settings-probe.json'), 'utf8'));
    assert.equal(probe.ourNamespace, false);
    assert.match(probe.error, /没有为 dsh-aftermath 建立设置命名空间/);
  });
});

test('零变更但写过根外文件：仍落一条轻记录，带路径线索', () => {
  withEnv(({ root, dir }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false });
    const session = { id: 'sess-quiet' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 3 } });
    const outside = path.join(dir, 'elsewhere', 'note.txt');
    host.emit(session, {
      type: 'tool/call',
      time: Date.now(),
      data: { callId: 'q1', name: 'bash', arguments: JSON.stringify({ command: `printf hi > "${outside.replace(/\\/g, '/')}"` }) },
    });
    host.emit(session, { type: 'tool/result', time: Date.now(), data: { callId: 'q1' } });
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 3 } });

    const records = readTurns({ limit: 5 });
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.kind, 'quiet');
    assert.equal(record.changes.length, 0);
    assert.equal(record.counts.total, 0);
    assert.equal(record.calls.length, 1);
    assert.equal(record.calls[0].mutating, true);
    assert.ok(
      record.calls[0].paths.some((p) => p.toLowerCase().endsWith('note.txt')),
      `命令里的绝对路径应该被留下来，实际：${JSON.stringify(record.calls[0].paths)}`,
    );
  });
});

test('关闭 recordQuietTurns 后，零变更回合不再落盘', () => {
  withEnv(({ root, dir }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false, recordQuietTurns: false });
    const session = { id: 'sess-quiet-off' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 4 } });
    host.emit(session, {
      type: 'tool/call',
      time: Date.now(),
      data: { callId: 'q2', name: 'bash', arguments: JSON.stringify({ command: `rm -f "${path.join(dir, 'x.txt').replace(/\\/g, '/')}"` }) },
    });
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 4 } });
    assert.equal(readTurns({ limit: 5 }).length, 0);
  });
});

test('零变更且只读：不落盘（不制造噪声）', () => {
  withEnv(({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false });
    const session = { id: 'sess-readonly' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 5 } });
    host.emit(session, {
      type: 'tool/call',
      time: Date.now(),
      data: { callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: path.join(root, 'keep.txt') }) },
    });
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 5 } });
    assert.equal(readTurns({ limit: 5 }).length, 0);
  });
});

test('quiet 记录能通过 aftermath_history 返回，不只存在于文件里', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const session = { id: 'sess-quiet-tool' };
    host.emit(session, { type: 'turn/start', time: Date.now() - 5000, data: { turn: 9 } });
    // 只在观测根之外写文件：根内零变更
    const outside = path.join(path.dirname(root), 'elsewhere.txt');
    host.emit(session, {
      type: 'tool/call',
      time: Date.now() - 4000,
      data: { callId: 'c9', name: 'bash', arguments: JSON.stringify({ command: 'printf x > "' + outside + '"' }), step: 1 },
    });
    fs.writeFileSync(outside, 'x');
    host.emit(session, { type: 'tool/result', time: Date.now() - 3000, data: { turn: 9, step: 1, callId: 'c9' } });
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 9 } });

    const tool = host.tools.find((t) => t.name === 'aftermath_history');
    assert.ok(tool, '工具已注册');
    const value = await tool.execute({ since: '1h', root: 'all', limit: 5 });
    assert.match(value.text, /根外|写操作/, 'quiet 轮不能被当成长"没有变更"');
  });
});

test('/aftermath roots --suggest 标出哪些常用目录还没加进来', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const result = await host.commands[0].handler({ rawInput: 'roots --suggest' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /\[已加\]|\[未加\]/);
    assert.match(result.text, /要盯着哪些地方/);
  });
});

test('/aftermath roots --add 预览加目录后的样子，不假装改配置', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], maskHome: false });
    const result = await host.commands[0].handler({ rawInput: 'roots --add D:/项目' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /准备加入/);
    assert.match(result.text, /插件不替你写宿主配置/);
    assert.match(result.text, /cordis\.patch\.yml/);
  });
});

test('面板路由：注册 /aftermath/recent 并返回可解析的 JSON', async () => {
  await withEnv(async ({ root }) => {
    const host = fakeHost();
    apply(host.ctx, { roots: [root], depth: 1, maskHome: false });
    assert.equal(host.routes.length, 1, '应该注册一条只读路由');
    const route = host.routes[0];
    assert.equal(route.kind, 'exact');
    assert.equal(route.path, '/aftermath/recent');
    assert.equal(typeof route.resource, 'function');

    const session = { id: 'sess-panel' };
    host.emit(session, { type: 'turn/start', time: Date.now(), data: { turn: 4 } });
    fs.writeFileSync(path.join(root, 'panel-made.txt'), 'x');
    host.emit(session, { type: 'turn/end', time: Date.now(), data: { turn: 4 } });

    const response = await route.resource(new Request('http://127.0.0.1/aftermath/recent'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.plugin, 'dsh-aftermath');
    assert.ok(Array.isArray(payload.turns));
    assert.equal(payload.turns[0].turn, 4);
    assert.ok(payload.turns[0].changes.some((change) => change.rel === 'panel-made.txt'));
    assert.equal(payload.totals.todayTurns >= 1, true);
  });
});
