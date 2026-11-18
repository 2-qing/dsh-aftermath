import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTurnReport, renderChatLine, renderHistory } from '../lib/report.js';
import { detectSymptoms } from '../lib/symptoms.js';

const ROOT = 'C:\\Users\\x\\Desktop';

function record(overrides = {}) {
  const changes = overrides.changes || [];
  return {
    v: 1,
    at: Date.parse('2026-11-17T14:32:05'),
    session: 'session-7',
    turn: 7,
    roots: [{ id: 'desktop', path: ROOT, ok: true }],
    skipped: [],
    counts: {
      created: changes.filter((c) => c.kind === 'created').length,
      deleted: changes.filter((c) => c.kind === 'deleted').length,
      modified: changes.filter((c) => c.kind === 'modified').length,
      moved: changes.filter((c) => c.kind === 'moved').length,
      total: changes.length,
      confidence: { certain: 0, likely: 0, window: 0, unattributed: 0 },
    },
    changes,
    calls: overrides.calls || [],
    ...overrides,
  };
}

test('renderTurnReport 空变更时给结论而不是空表', () => {
  const text = renderTurnReport(record(), { maskHome: false });
  assert.match(text, /第 7 轮/);
  assert.match(text, /会话 #7/);
  assert.match(text, /没有文件变更/);
});

test('renderTurnReport 列出逐条变更与归因标记', () => {
  const text = renderTurnReport(
    record({
      changes: [
        {
          kind: 'deleted',
          rootId: 'desktop',
          root: ROOT,
          rel: '旧的.lnk',
          before: { size: 1024, mtime: Date.parse('2026-11-17T14:30:00') },
          after: null,
          attribution: { confidence: 'certain', how: 'exact-path', tool: 'bash', verb: 'rm', excerpt: 'rm 旧的.lnk' },
        },
      ],
    }),
    { maskHome: false },
  );
  assert.match(text, /\| 删除 \| 旧的\.lnk \| 1\.0 KB \|/);
  assert.match(text, /✔确定/);
  assert.match(text, /bash · rm/);
  assert.doesNotMatch(text, /归因不到的部分/);
});

test('renderTurnReport 把弱归因单独成节并列出命令原文', () => {
  const text = renderTurnReport(
    record({
      changes: [
        {
          kind: 'modified',
          rootId: 'desktop',
          root: ROOT,
          rel: 'a.txt',
          before: { size: 1, mtime: 1 },
          after: { size: 2, mtime: 2 },
          attribution: { confidence: 'unattributed', how: 'no-mutating-evidence', tool: null, verb: null, excerpt: null },
        },
      ],
      calls: [{ name: 'bash', excerpt: 'Get-ChildItem C:\\Users\\x\\Desktop' }],
    }),
    { maskHome: false },
  );
  assert.match(text, /归因不到的部分/);
  assert.match(text, /无法逐文件归因/);
  assert.match(text, /Get-ChildItem/);
});

test('renderTurnReport 命中“图标变白”症状并给出检查命令', () => {
  const deleted = Array.from({ length: 3 }, (_, i) => ({
    kind: 'deleted',
    rootId: 'desktop',
    root: ROOT,
    rel: `快捷方式${i}.lnk`,
    before: { size: 100, mtime: 1 },
    after: null,
    attribution: { confidence: 'likely', how: 'under-changed-dir', tool: 'bash', verb: 'rm' },
  }));
  const text = renderTurnReport(record({ changes: deleted }), { maskHome: false });
  assert.match(text, /桌面图标大面积变空白/);
  assert.match(text, /WScript\.Shell/);
  assert.match(text, /ie4uinit\.exe -show/);
});

test('renderTurnReport 显示被跳过的根', () => {
  const text = renderTurnReport(
    record({ skipped: [{ id: 'desktop', reason: 'missing-root' }] }),
    { maskHome: false },
  );
  assert.match(text, /跳过的根/);
  assert.match(text, /missing-root/);
});

test('renderChatLine 概括一轮', () => {
  const line = renderChatLine(record({
    counts: { created: 1, deleted: 3, modified: 0, moved: 0, total: 4, confidence: { certain: 2, likely: 1, window: 1, unattributed: 0 } },
  }));
  assert.match(line, /4 处文件变更/);
  assert.match(line, /删除 3/);
  assert.match(line, /1 处仅时间窗可对应/);
});

test('renderChatLine 无变更时如实说没变更', () => {
  assert.match(renderChatLine(record()), /未观测到文件变更/);
});

test('renderHistory 输出多轮表格，并区分会话', () => {
  const text = renderHistory([
    { at: Date.parse('2026-11-17T14:00:00'), session: 'aaaa1111-xxxx-0000', turn: 2, counts: { deleted: 2, total: 2, confidence: { certain: 2 } } },
    { at: Date.parse('2026-11-17T15:00:00'), session: 'bbbb2222-yyyy-0000', turn: 3, counts: { created: 1, total: 1, confidence: { likely: 1 } } },
  ]);
  assert.match(text, /最近 2 轮变更/);
  assert.match(text, /\| 会话 \|/);
  assert.match(text, /aaaa1111/);
  assert.match(text, /bbbb2222/);
  assert.match(text, /删除2/);
  assert.match(text, /新建1/);
});

test('shortSession 保留人为标记、压缩真实 id', () => {
  const text = renderHistory([
    { at: Date.parse('2026-11-17T16:00:00'), session: 'unknown', turn: 1, counts: { total: 0, confidence: {} } },
    { at: Date.parse('2026-11-17T17:00:00'), session: '9f3a2b7c-1234-5678-9abc-def012345678', turn: 2, counts: { total: 0, confidence: {} } },
    { at: Date.parse('2026-11-17T18:00:00'), session: 'session-12', turn: 3, counts: { total: 0, confidence: {} } },
  ]);
  assert.match(text, /unknown/);
  assert.match(text, /9f3a2b7c/);
  assert.match(text, /#12/);
});

test('detectSymptoms 在只有非快捷方式删除时给出“文件不见了”而不是“图标变白”', () => {
  const changes = [
    {
      kind: 'deleted',
      rootId: 'desktop',
      root: ROOT,
      rel: '合同.docx',
      before: { size: 10, mtime: 1 },
      after: null,
    },
  ];
  const symptoms = detectSymptoms(changes, { roots: [{ id: 'desktop', path: ROOT, ok: true }] });
  assert.equal(symptoms[0].id, 'desktop-files-gone');
});

test('detectSymptoms 桌面根读不到时提示可能被重定向', () => {
  const symptoms = detectSymptoms([], { roots: [{ id: 'desktop', path: ROOT, ok: false, error: 'missing-root' }] });
  assert.ok(symptoms.some((s) => s.id === 'desktop-redirected'));
});
