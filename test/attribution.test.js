import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEvidence,
  attributeChanges,
  summarizeConfidence,
  normalizePath,
  globToRegex,
} from '../lib/attribution.js';

const ROOT = 'C:\\Users\\x\\Desktop';

const call = (name, args, at = 10000) => ({
  callId: `${name}-1`,
  name,
  arguments: JSON.stringify(args),
  at,
});

const change = (kind, rel, before, after) => ({
  kind,
  rootId: 'desktop',
  root: ROOT,
  rel,
  before,
  after,
});

test('extractEvidence：shell 写动词 → mutating，并抽出绝对路径', () => {
  const evidence = extractEvidence(call('bash', { command: 'mv C:/Users/x/Desktop/a.txt C:/Users/x/Desktop/b.txt' }));
  assert.equal(evidence.mutating, true);
  assert.equal(evidence.source, 'shell');
  assert.equal(evidence.verb, 'mv');
  assert.ok(evidence.absPaths.some((p) => p.lower === 'c:\\users\\x\\desktop\\a.txt'));
  assert.ok(evidence.absPaths.some((p) => p.lower === 'c:\\users\\x\\desktop\\b.txt'));
});

test('extractEvidence：只读命令不算写操作', () => {
  const evidence = extractEvidence(call('bash', { command: 'Get-Content C:/Users/x/Desktop/a.txt' }));
  assert.equal(evidence.mutating, false);
  assert.equal(evidence.readOnly, true);
  assert.equal(evidence.verb, null);
});

test('extractEvidence：写工具按名字识别，即使没有 shell 动词', () => {
  const evidence = extractEvidence(call('write', { file_path: 'C:/Users/x/Desktop/new.txt', content: 'hi' }));
  assert.equal(evidence.mutating, true);
  assert.equal(evidence.verb, 'tool:write');
});

test('extractEvidence：读工具按名字识别', () => {
  const evidence = extractEvidence(call('read', { file_path: 'C:/Users/x/Desktop/a.txt' }));
  assert.equal(evidence.mutating, false);
});

test('extractEvidence：参数不是 JSON 也不崩，退化为正则扫原文', () => {
  const evidence = extractEvidence({ name: 'bash', arguments: 'rm -f C:/Users/x/Desktop/a.txt', at: 1 });
  assert.equal(evidence.parseable, false);
  assert.equal(evidence.mutating, true);
  assert.equal(evidence.absPaths.length, 1);
});

test('exact-path 命中 → certain', () => {
  const changes = attributeChanges(
    [change('deleted', 'a.txt', { size: 1, mtime: 1 }, null)],
    [call('bash', { command: 'rm C:/Users/x/Desktop/a.txt' })],
  );
  assert.equal(changes[0].attribution.confidence, 'certain');
  assert.equal(changes[0].attribution.how, 'exact-path');
  assert.equal(changes[0].attribution.tool, 'bash');
});

test('glob 命中 → certain', () => {
  const changes = attributeChanges(
    [change('deleted', '报告 1.docx', { size: 1, mtime: 1 }, null)],
    [call('bash', { command: 'Remove-Item "C:/Users/x/Desktop/报告*.docx"' })],
  );
  assert.equal(changes[0].attribution.confidence, 'certain');
  assert.equal(changes[0].attribution.how, 'glob-path');
});

test('落在被写目录之下 → likely', () => {
  const changes = attributeChanges(
    [change('deleted', 'sub\\b.txt', { size: 1, mtime: 1 }, null)],
    [call('bash', { command: 'rm -rf C:/Users/x/Desktop/sub' })],
  );
  assert.equal(changes[0].attribution.confidence, 'likely');
  assert.equal(changes[0].attribution.how, 'under-changed-dir');
});

test('只读调用提到同一路径也不算证据', () => {
  const changes = attributeChanges(
    [change('modified', 'a.txt', { size: 1, mtime: 1 }, { size: 2, mtime: 2 })],
    [call('bash', { command: 'Get-Content C:/Users/x/Desktop/a.txt' })],
  );
  assert.notEqual(changes[0].attribution.confidence, 'certain');
  assert.equal(changes[0].attribution.confidence, 'unattributed');
});

test('只出现文件名且本轮唯一 → likely', () => {
  const changes = attributeChanges(
    [change('deleted', '报告.txt', { size: 3, mtime: 1 }, null)],
    [call('bash', { command: 'ren 报告.txt 旧报告.txt', at: 10000 })],
  );
  assert.equal(changes[0].attribution.confidence, 'likely');
  assert.equal(changes[0].attribution.how, 'basename');
});

test('同名文件出现两次时不靠文件名归因', () => {
  const changes = attributeChanges(
    [
      change('deleted', 'a\\dup.lnk', { size: 1, mtime: 1 }, null),
      change('deleted', 'b\\dup.lnk', { size: 1, mtime: 1 }, null),
    ],
    [call('bash', { command: 'ren dup.lnk dup2.lnk', at: 10000 })],
  );
  for (const item of changes) {
    assert.notEqual(item.attribution.how, 'basename');
  }
});

test('只能落到时间窗 → window', () => {
  const changes = attributeChanges(
    [change('created', 'c.txt', null, { size: 1, mtime: 10500 })],
    [call('bash', { command: 'touch C:/Users/x/Desktop/other.txt', at: 10000 })],
  );
  assert.equal(changes[0].attribution.confidence, 'window');
});

test('没有任何写调用 → unattributed，并说明原因', () => {
  const changes = attributeChanges(
    [change('deleted', 'a.txt', { size: 1, mtime: 1 }, null)],
    [call('bash', { command: 'ls C:/Users/x/Desktop' })],
  );
  assert.equal(changes[0].attribution.confidence, 'unattributed');
  assert.equal(changes[0].attribution.how, 'no-mutating-evidence');
});

test('一轮内没有工具调用 → unattributed:no-tool-calls', () => {
  const changes = attributeChanges([change('created', 'a.txt', null, { size: 1, mtime: 1 })], []);
  assert.equal(changes[0].attribution.how, 'no-tool-calls');
});

test('summarizeConfidence 统计四档', () => {
  const changes = [
    { attribution: { confidence: 'certain' } },
    { attribution: { confidence: 'likely' } },
    { attribution: { confidence: 'window' } },
    { attribution: { confidence: 'unattributed' } },
    { attribution: null },
  ];
  assert.deepEqual(summarizeConfidence(changes), { certain: 1, likely: 1, window: 1, unattributed: 2 });
});

test('normalizePath 统一分隔符并去掉尾部分隔符', () => {
  assert.equal(normalizePath('C:/Users/x/Desktop/'), 'C:\\Users\\x\\Desktop');
  assert.equal(normalizePath('  '), '');
});

test('globToRegex 处理 * 与 ?', () => {
  assert.equal(globToRegex('C:\\a\\*.txt').test('C:\\a\\b.txt'), true);
  assert.equal(globToRegex('C:\\a\\?.txt').test('C:\\a\\bb.txt'), false);
});

test('渲染标签按 how 细分：区间命中不能说成「时间窗内」', async () => {
  const { confidenceLabel } = await import('../lib/attribution.js');
  assert.deepEqual(confidenceLabel({ confidence: 'window', how: 'call-interval' }), { mark: '○', label: '区间内' });
  assert.deepEqual(confidenceLabel({ confidence: 'window', how: 'call-interval-open' }), { mark: '○', label: '区间内·未封口' });
  assert.deepEqual(confidenceLabel({ confidence: 'window', how: 'turn-window' }), { mark: '○', label: '时间窗内' });
  assert.deepEqual(confidenceLabel({ confidence: 'window', how: 'mutating-call-in-turn' }), { mark: '○', label: '时间窗内·无发生时间' });
  assert.deepEqual(confidenceLabel({ confidence: 'certain', how: 'exact-path' }), { mark: '✔', label: '确定' });
  assert.deepEqual(confidenceLabel({ confidence: 'unattributed', how: 'no-mutating-evidence' }), { mark: '？', label: '无法归因' });
  assert.deepEqual(confidenceLabel(undefined), { mark: '？', label: '无法归因' });
});
