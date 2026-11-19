import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeChanges,
  analyzeIntervals,
  extractEvidence,
  DEFAULT_SLACK_MS,
} from '../lib/attribution.js';

const ROOT = 'C:\\Users\\x\\Desktop';

const change = (kind, rel, before, after) => ({
  kind,
  rootId: 'desktop',
  root: ROOT,
  rel,
  before,
  after,
});

/** 便于构造带结束时刻的调用；命令里故意不提任何路径，逼归因只能靠时间。 */
const call = (args, at, endAt = null) => ({
  callId: `c-${at}`,
  name: 'bash',
  arguments: JSON.stringify(args),
  at,
  endAt,
});

const NOISE = { command: 'npm run build' };

test('extractEvidence 暴露调用起止时刻与 step', () => {
  const evidence = extractEvidence({ name: 'bash', arguments: '{}', at: 100, endAt: 250, step: 3 });
  assert.equal(evidence.startAt, 100);
  assert.equal(evidence.endAt, 250);
  assert.equal(evidence.step, 3);
});

test('mtime 落在某次调用的起止之间 → window / call-interval', () => {
  const changes = attributeChanges(
    [change('modified', 'a.txt', null, { size: 1, mtime: 31000 })],
    [call(NOISE, 10000, 12000), call(NOISE, 30000, 30500)],
    { slackMs: 500 },
  );
  assert.equal(changes[0].attribution.confidence, 'window');
  assert.equal(changes[0].attribution.how, 'call-interval');
  // 命中的是第二次调用
  assert.equal(changes[0].attribution.callIndex, 1);
});

test('区间不命中、只落在回合宽窗 → window / turn-window', () => {
  const changes = attributeChanges(
    [change('modified', 'a.txt', null, { size: 1, mtime: 22000 })],
    [call(NOISE, 10000, 10500), call(NOISE, 30000, 30500)],
    { slackMs: 500 },
  );
  assert.equal(changes[0].attribution.confidence, 'window');
  assert.equal(changes[0].attribution.how, 'turn-window');
});

test('多个区间都命中时取最窄的那个', () => {
  const changes = attributeChanges(
    [change('modified', 'a.txt', null, { size: 1, mtime: 30000 })],
    [call(NOISE, 10000, 60000), call(NOISE, 29000, 31000)],
    { slackMs: 0 },
  );
  assert.equal(changes[0].attribution.how, 'call-interval');
  assert.equal(changes[0].attribution.callIndex, 1);
});

test('没等到 tool/result 的调用用回合结束时刻封口 → call-interval-open', () => {
  const changes = attributeChanges(
    [change('modified', 'a.txt', null, { size: 1, mtime: 15000 })],
    [call(NOISE, 10000, null)],
    { slackMs: 200, turnEndAt: 20000 },
  );
  assert.equal(changes[0].attribution.how, 'call-interval-open');
});

test('容差为 0 时区间边界外的 mtime 退回 turn-window', () => {
  const changes = attributeChanges(
    [change('modified', 'a.txt', null, { size: 1, mtime: 11000 })],
    [call(NOISE, 10000, 10500)],
    { slackMs: 0 },
  );
  assert.equal(changes[0].attribution.how, 'turn-window');
});

test('删除没有发生时间，仍然只要求本轮有写调用', () => {
  const changes = attributeChanges(
    [change('deleted', 'a.txt', { size: 1, mtime: 1 }, null)],
    [call(NOISE, 10000, 12000)],
  );
  assert.equal(changes[0].attribution.confidence, 'window');
  assert.equal(changes[0].attribution.how, 'mutating-call-in-turn');
});

test('analyzeIntervals 统计区间可用性与重叠', () => {
  const stats = analyzeIntervals(
    [
      call(NOISE, 10000, 12000),
      call(NOISE, 11000, 13000),
      { callId: 'x', name: 'bash', arguments: JSON.stringify(NOISE), at: 20000, endAt: null },
      { callId: 'y', name: 'read', arguments: JSON.stringify({ path: 'C:/a.txt' }), at: 21000, endAt: 21500 },
    ],
    { slackMs: 0, turnEndAt: 25000 },
  );
  assert.equal(stats.calls, 4);
  assert.equal(stats.mutating, 3, 'read 不算写操作');
  assert.equal(stats.timed, 3);
  assert.equal(stats.closed, 2, '只有两条拿到了结束时刻');
  assert.equal(stats.overlaps, 1);
  assert.equal(stats.slackMs, 0);
  assert.deepEqual(stats.unknownTools, [], 'bash 是脚本宿主、read 是只读表，不算未知工具');
});

test('analyzeIntervals 把不在已知名单里的工具名列出来', () => {
  const stats = analyzeIntervals(
    [
      { callId: 'a', name: 'tool-special-write', arguments: JSON.stringify({ path: 'C:/a.txt' }), at: 1000, endAt: 1200 },
      { callId: 'b', name: 'write', arguments: JSON.stringify({ file_path: 'C:/b.txt' }), at: 2000, endAt: 2200 },
      { callId: 'c', name: 'browser_edit', arguments: JSON.stringify({ selector: 'x' }), at: 3000, endAt: 3200 },
    ],
    { slackMs: 0, turnEndAt: 4000 },
  );
  assert.deepEqual(stats.unknownTools, ['tool-special-write', 'browser_edit'], 'write 在写表里，其余两个是未知工具');
});

test('默认容差是 1500ms', () => {
  assert.equal(DEFAULT_SLACK_MS, 1500);
  const changes = attributeChanges(
    [change('modified', 'a.txt', null, { size: 1, mtime: 11400 })],
    [call(NOISE, 10000, 10000)],
  );
  assert.equal(changes[0].attribution.how, 'call-interval');
});