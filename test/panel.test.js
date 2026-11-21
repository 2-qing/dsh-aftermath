import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPanelPayload, PANEL_HEADERS, PANEL_PATH } from '../lib/panel.js';

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\me';
const win = (...parts) => path.win32.join(...parts);

function record(overrides = {}) {
  return {
    at: Date.parse('2026-11-18T10:00:00'),
    session: 'session-01c4eb63-06ec',
    turn: 12,
    kind: 'changes',
    counts: { created: 1, deleted: 2, modified: 0, moved: 0, total: 3, confidence: { certain: 1, likely: 1, window: 1, unattributed: 0 } },
    changes: [
      {
        kind: 'deleted',
        root: win(HOME, 'Desktop'),
        rel: 'gone.lnk',
        before: { size: 1024, mtime: Date.parse('2026-03-21T13:05:01') },
        attribution: { kind: 'deleted', confidence: 'likely', how: 'basename', tool: 'bash', verb: 'rm' },
      },
    ],
    ...overrides,
  };
}

test('面板数据：路径按 maskHome 打码、删除行取删除前的 mtime', () => {
  const payload = buildPanelPayload({
    records: [record()],
    roots: [{ id: 'desktop', path: win(HOME, 'Desktop'), exists: true }],
    config: { maskHome: true, enabled: true },
    version: '0.6.0',
    now: Date.parse('2026-11-18T10:05:00'),
    todayTurns: 3,
    todayChanges: 7,
  });

  assert.equal(payload.plugin, 'dsh-aftermath');
  assert.equal(payload.version, '0.6.0');
  assert.equal(payload.enabled, true);
  assert.equal(payload.roots[0].path, win('~', 'Desktop'));
  assert.equal(payload.totals.todayTurns, 3);
  assert.equal(payload.totals.todayChanges, 7);

  const change = payload.turns[0].changes[0];
  assert.equal(change.kind, 'deleted');
  assert.equal(change.path, win('~', 'Desktop', 'gone.lnk'));
  assert.equal(change.size, 1024);
  assert.equal(new Date(change.mtime).getUTCFullYear(), 2026);
  assert.equal(change.confidence, 'likely');
  assert.equal(change.tool, 'bash');
});

test('面板数据：关掉打码时给完整路径，并区分 quiet 轮', () => {
  const payload = buildPanelPayload({
    records: [record({ kind: 'quiet', changes: [], counts: { total: 0, confidence: {} } })],
    roots: [],
    config: { maskHome: false },
    version: '0.6.0',
  });
  assert.equal(payload.maskHome, false);
  assert.equal(payload.turns[0].kind, 'quiet');
  assert.equal(payload.turns[0].total, 0);
  assert.equal(payload.turns[0].changes.length, 0);
});

test('面板数据：最多 8 轮，每轮最多 20 条变更并标记截断', () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    kind: 'created',
    root: win(HOME, 'Desktop'),
    rel: `f${index}.txt`,
    after: { size: 1, mtime: 1 },
    attribution: { confidence: 'certain', how: 'exact-path', tool: 'write', verb: 'tool:write' },
  }));
  const records = Array.from({ length: 12 }, (_, index) => record({ turn: index + 1, changes: many }));
  const payload = buildPanelPayload({ records, roots: [], config: {}, version: '0.6.0' });
  assert.equal(payload.turns.length, 8);
  assert.equal(payload.turns[0].changes.length, 20);
  assert.equal(payload.turns[0].changesTruncated, true);
});

test('面板数据：根外路径上限 10 条并保留工具标签', () => {
  const outside = Array.from({ length: 15 }, (_, index) => ({ path: `D:\\x\\f${index}.txt`, count: index + 1, tools: ['bash · rm'] }));
  const payload = buildPanelPayload({
    records: [{ ...record(), outside }],
    roots: [],
    config: { maskHome: false },
    version: '0.6.0',
  });
  assert.equal(payload.outside.length, 10);
  assert.equal(payload.outside[0].count, 1);
  assert.deepEqual(payload.outside[0].tools, ['bash · rm']);
});

test('面板路由常量与响应头', () => {
  assert.equal(PANEL_PATH, '/aftermath/recent');
  assert.match(PANEL_HEADERS['content-type'], /application\/json/);
  assert.equal(PANEL_HEADERS['cache-control'], 'no-store');
  assert.equal(PANEL_HEADERS['x-content-type-options'], 'nosniff');
});
test('超出预算的轮次与存档体积都出现在 payload 里', () => {
  const payload = buildPanelPayload({
    records: [record({ truncated: true })],
    roots: [{ id: 'desktop', path: win(HOME, 'Desktop'), exists: true }],
    config: { maskHome: true },
    storage: { bytes: 300 * 1024 * 1024, files: 12, oldest: '2026-11-01', newest: '2026-11-21', warnMB: 200, over: true },
  });
  assert.equal(payload.turns[0].truncated, true);
  assert.equal(payload.storage.over, true);
  assert.equal(payload.storage.warnMB, 200);
  assert.equal(payload.storage.files, 12);
});

test('没有 storage 输入时 payload 里是 null，面板不会崩', () => {
  const payload = buildPanelPayload({ records: [record()], roots: [], config: {} });
  assert.equal(payload.storage, null);
  assert.equal(payload.turns[0].truncated, false);
});

test('相对路径里的敏感文件名也打码', () => {
  const payload = buildPanelPayload({
    records: [
      record({
        changes: [
          {
            kind: 'modified',
            root: win(HOME, 'proj'),
            rel: '.env.production',
            before: { size: 1, mtime: 1 },
            after: { size: 2, mtime: 2 },
            attribution: { confidence: 'certain', how: 'exact-path', tool: 'bash', verb: 'tee' },
          },
        ],
      }),
    ],
    roots: [],
    config: { maskHome: true },
  });
  const change = payload.turns[0].changes[0];
  assert.equal(change.rel, '***');
  assert.doesNotMatch(change.path, /\.env\.production/);
});
