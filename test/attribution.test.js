import path from 'node:path';
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
  assert.equal(evidence.source, 'read');
  assert.equal(evidence.verb, 'get-content');
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

test('输出重定向也算写操作，否则这类调用会丢掉区间证据', async () => {
  const { extractEvidence } = await import('../lib/attribution.js');
  const ev = (command) => extractEvidence({ callId: 'c', name: 'bash', at: 1, arguments: JSON.stringify({ command }) });
  const W = String.fromCharCode(92);
  const abs = ['C:', W, 'Users', W, 'me', W, 'Desktop', W, 'out.txt'].join('');

  const redirect = ev('printf hello > note.txt');
  assert.equal(redirect.mutating, true);
  assert.equal(redirect.source, 'redirect');
  assert.equal(redirect.verb, '>');

  const append = ev(`echo hi >> ${abs}`);
  assert.equal(append.mutating, true);
  assert.equal(append.verb, '>>');
  assert.ok(append.absPaths.some((p) => p.lower.endsWith('out.txt')), '追加的绝对路径要进证据');

  const stderr = ev('cmd.exe //c dir 2> err.txt');
  assert.equal(stderr.mutating, true);
  assert.equal(stderr.verb, '2>');

  assert.equal(ev('echo "a > b"').mutating, false, '引号里的 > 是文本');
  assert.equal(ev(`Get-Process | Out-File ${abs}`).verb, 'out-file');
});

test('引号包着的重定向目标、MSYS 路径、脚本宿主里的只读动词都判对', async () => {
  const { extractEvidence } = await import('../lib/attribution.js');
  const ev = (command) => extractEvidence({ callId: 'c', name: 'bash', at: 1, arguments: JSON.stringify({ command }) });
  // 用 join 拼期望值，避免源码里出现反斜杠字面量
  const win = (...parts) => path.win32.join(...parts).toLowerCase();

  const quoted = ev('printf x >> "/c/Users/me/Desktop/a.txt"');
  assert.equal(quoted.mutating, true, '引号里的目标也是写');
  assert.ok(quoted.absPaths.some((p) => p.lower === win('c:', 'Users', 'me', 'Desktop', 'a.txt')), 'MSYS 路径要翻成 Windows 绝对路径');

  const msys = ev('rm -f /c/Users/me/Desktop/old.txt');
  assert.equal(msys.mutating, true);
  assert.ok(msys.absPaths.some((p) => p.lower === win('c:', 'Users', 'me', 'Desktop', 'old.txt')));

  const readOnly = ev('powershell -NoProfile -Command "Get-Content a.txt"');
  assert.equal(readOnly.mutating, false, 'powershell 里只读动词不该算写');
  assert.equal(readOnly.source, 'read');

  const hostWrite = ev('powershell -NoProfile -Command "Remove-Item a.txt"');
  assert.equal(hostWrite.mutating, true);

  const hostOnly = ev('node build.js');
  assert.equal(hostOnly.mutating, true, '只看到脚本宿主、看不出读写时保守算写');
});
