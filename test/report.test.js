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

test('renderTurnReport 输出报告健康度：耗时、覆盖量、区间可用性', () => {
  const changes = [
    {
      kind: 'modified',
      rootId: 'desktop',
      root: ROOT,
      rel: 'a.txt',
      before: { size: 1, mtime: 1 },
      after: { size: 2, mtime: 2 },
      attribution: { confidence: 'certain', how: 'exact-path', tool: 'write', verb: 'tool:write' },
    },
    {
      kind: 'modified',
      rootId: 'desktop',
      root: ROOT,
      rel: 'b.txt',
      before: { size: 1, mtime: 1 },
      after: { size: 2, mtime: 2 },
      attribution: { confidence: 'window', how: 'call-interval', tool: 'bash', verb: 'rm' },
    },
  ];
  const text = renderTurnReport(
    record({
      changes,
      counts: {
        created: 0,
        deleted: 0,
        modified: 2,
        moved: 0,
        total: 2,
        confidence: { certain: 1, likely: 0, window: 1, unattributed: 0 },
      },
      health: {
        scanMs: 12,
        roots: 2,
        scanned: 446,
        changed: 2,
        listed: 2,
        truncated: false,
        intervals: { calls: 5, mutating: 3, timed: 3, closed: 2, overlaps: 1, slackMs: 1500 },
      },
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /## 报告健康度/);
  assert.match(text, /12 ms/);
  assert.match(text, /446 个条目/);
  assert.match(text, /确定 1（50%）/);
  assert.match(text, /2\/3 拿到起止时刻/);
  assert.match(text, /1 次没等到结果/);
  assert.match(text, /1 对区间重叠/);
  assert.doesNotMatch(text, /未列全/);
});

test('没有 health 字段的旧记录照常渲染，不出现健康度小节', () => {
  const text = renderTurnReport(record(), { maskHome: false });
  assert.doesNotMatch(text, /报告健康度/);
});

test('截断时明说只列了前几条', () => {
  const changes = [
    {
      kind: 'created',
      rootId: 'desktop',
      root: ROOT,
      rel: 'a.txt',
      before: null,
      after: { size: 2, mtime: 2 },
      attribution: { confidence: 'certain', how: 'exact-path', tool: 'write', verb: 'tool:write' },
    },
  ];
  const text = renderTurnReport(
    record({
      changes,
      counts: { created: 1, deleted: 0, modified: 0, moved: 0, total: 1, confidence: { certain: 1, likely: 0, window: 0, unattributed: 0 } },
      health: { scanMs: 3, roots: 1, scanned: 10, changed: 240, listed: 200, truncated: true, intervals: { timed: 0 } },
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /未列全/);
  assert.match(text, /前 200 条/);
  assert.match(text, /时间证据只到回合宽窗/);
});

test('区间命中的变更在表格里写「区间内」，健康度把时间窗再拆一层', () => {
  const changes = [
    {
      kind: 'created',
      rootId: 'desktop',
      root: ROOT,
      rel: 'in-interval.txt',
      after: { size: 1, mtime: 3 },
      attribution: { confidence: 'window', how: 'call-interval', tool: 'bash', verb: 'npm', callIndex: 0 },
    },
    {
      kind: 'created',
      rootId: 'desktop',
      root: ROOT,
      rel: 'wide-window.txt',
      after: { size: 1, mtime: 9 },
      attribution: { confidence: 'window', how: 'turn-window', tool: 'bash', verb: 'npm', callIndex: 0 },
    },
  ];
  const text = renderTurnReport(
    record({
      changes,
      counts: {
        created: 2,
        deleted: 0,
        modified: 0,
        moved: 0,
        total: 2,
        confidence: { certain: 0, likely: 0, window: 2, unattributed: 0 },
      },
      health: {
        scanMs: 1,
        roots: 1,
        scanned: 10,
        changed: 2,
        listed: 2,
        truncated: false,
        intervals: { calls: 2, mutating: 2, timed: 2, closed: 2, overlaps: 0, slackMs: 1500 },
      },
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /\| 新建 \| in-interval\.txt \|.*○区间内 \|/);
  assert.match(text, /\| 新建 \| wide-window\.txt \|.*○时间窗内 \|/);
  assert.match(text, /时间证据：1 处 mtime 落在某次调用的起止区间内，1 处只落在整轮宽窗/);
});

test('零变更但写过命令：指明改动可能落在观测根之外', () => {
  const text = renderTurnReport(
    record({
      calls: [
        {
          name: 'bash',
          verb: 'redirect',
          mutating: true,
          excerpt: 'printf hi > D:/项目/a.txt',
          at: 1,
          endAt: 2,
          paths: ['D:/项目/a.txt'],
        },
      ],
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /执行过 1 条写操作/);
  assert.match(text, /printf hi/);
  assert.match(text, /不在观测根内的路径/);
  assert.match(text, /a\.txt/);
});

test('根内路径不进“根外”清单，根外路径去重并计数', () => {
  const inside = renderTurnReport(
    record({
      calls: [{ name: 'bash', mutating: true, excerpt: 'rm gone.txt', at: 1, endAt: 2, paths: [`${ROOT}/gone.txt`] }],
    }),
    { maskHome: false, symptoms: false },
  );
  assert.doesNotMatch(inside, /不在观测根内的路径/);

  const outside = renderTurnReport(
    record({
      calls: [
        { name: 'bash', verb: 'rm', mutating: true, excerpt: 'rm E:/x.log', at: 1, endAt: 2, paths: ['E:/x.log'] },
        { name: 'bash', verb: 'rm', mutating: true, excerpt: 'rm e:\\X.LOG', at: 3, endAt: 4, paths: ['e:\\X.LOG'] },
      ],
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(outside, /不在观测根内的路径/);
  assert.match(outside, /x\.log` ×2/);
});

test('renderHistory 标出“写过命令但根内无变更”的轮次', () => {
  const text = renderHistory([
    record({
      calls: [{ name: 'bash', mutating: true, excerpt: 'rm D:/x', at: 1, endAt: 2, paths: ['D:/x'] }],
    }),
  ]);
  assert.match(text, /0（写过 1 条命令，根外？）/);
});

test('打码有边界：Alice 不会被当成 Al 打码，命令原文里的家目录也会打掉', () => {
  const originalUser = process.env.USERPROFILE;
  const win = (...parts) => parts.join(String.fromCharCode(92));
  process.env.USERPROFILE = win('C:', 'Users', 'Al');
  try {
    const home = win('C:', 'Users', 'Al');
    const other = win('C:', 'Users', 'Alice', 'Desktop', 'keep.txt');
    const text = renderTurnReport(
      record({
        roots: [{ id: 'desktop', path: win(home, 'Desktop'), ok: true, complete: true }],
        changes: [],
        calls: [{ name: 'bash', mutating: true, excerpt: `rm ${other}`, at: 1, endAt: 2 }],
        counts: { created: 0, deleted: 0, modified: 0, moved: 0, total: 0, confidence: { certain: 0, likely: 0, window: 0, unattributed: 0 } },
      }),
      { symptoms: false },
    );
    assert.match(text, /Desktop）/, '根路径里的家目录该打码成 ~');
    assert.ok(!text.includes(home + String.fromCharCode(92)), '不该出现未打码的家目录');
    assert.match(text, /Alice/, 'Alice 不能被当成 Al 前缀误伤');
  } finally {
    if (originalUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUser;
  }
});

test('删除行的 mtime 列标成"删除前"，不冒充删除时刻', () => {
  const text = renderTurnReport(
    record({
      changes: [
        {
          kind: 'deleted',
          rootId: 'desktop',
          root: ROOT,
          rel: 'gone.txt',
          before: { size: 1, mtime: Date.parse('2026-11-17T14:32:05') },
          after: null,
          attribution: { confidence: 'certain', how: 'exact-path', tool: 'bash', verb: 'rm' },
        },
      ],
      counts: { created: 0, deleted: 1, modified: 0, moved: 0, total: 1, confidence: { certain: 1, likely: 0, window: 0, unattributed: 0 } },
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /\| 删除 \| gone\.txt \| 1 B \| 删除前 14:32:05 \|/);
  assert.match(text, /\| 变更 \| 条目 \| 大小 \| mtime \|/);
});

test('观测根不完整时报告开头就说明，不假装一切正常', () => {
  const text = renderTurnReport(
    record({ roots: [{ id: 'desktop', path: ROOT, ok: true, complete: false, truncated: true }] }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /本轮观测不完整/);
  assert.match(text, /desktop/);
});

test('并行配对有歧义时健康度写出来', () => {
  const text = renderTurnReport(
    record({
      changes: [
        {
          kind: 'created',
          rootId: 'desktop',
          root: ROOT,
          rel: 'a.txt',
          before: null,
          after: { size: 1, mtime: 2 },
          attribution: { confidence: 'window', how: 'call-interval', tool: 'bash', verb: 'rm' },
        },
      ],
      counts: { created: 1, deleted: 0, modified: 0, moved: 0, total: 1, confidence: { certain: 0, likely: 0, window: 1, unattributed: 0 } },
      health: { scanMs: 1, roots: 1, scanned: 5, changed: 1, listed: 1, truncated: false, ambiguousResults: 2, intervals: { calls: 2, mutating: 2, timed: 2, closed: 2, overlaps: 0, slackMs: 1500 } },
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /配对歧义：2 次/);
});

test('根外清单里丢掉空设备（旧记录里已经存了 \dev\null）', () => {
  const text = renderTurnReport(
    record({
      changes: [
        {
          kind: 'created',
          rootId: 'desktop',
          root: ROOT,
          rel: 'a.txt',
          after: { size: 1, mtime: 2 },
          attribution: { confidence: 'certain', how: 'exact-path', tool: 'write' },
        },
      ],
      calls: [
        { name: 'bash', verb: '>', mutating: true, at: 1, paths: ['\dev\null', 'D:/tools/x.log'] },
      ],
    }),
    { maskHome: false, symptoms: false },
  );
  assert.match(text, /D:\/tools\/x\.log/);
  assert.doesNotMatch(text, /dev\\null|\dev\null/);
});
