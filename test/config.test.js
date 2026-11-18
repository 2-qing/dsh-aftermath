import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, expandHome, resolveRoots, dshHome, stateDir } from '../lib/config.js';

function withTempHome(fn) {
  const original = process.env.USERPROFILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftermath-home-'));
  process.env.USERPROFILE = dir;
  try {
    return fn(dir);
  } finally {
    if (original === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeConfig 给缺失项兜底并夹取越界值', () => {
  const cfg = normalizeConfig({ depth: 99, maxEntries: 5, retentionDays: 0, enabled: 'yes' });
  assert.equal(cfg.depth, 6);
  assert.equal(cfg.maxEntries, 100);
  assert.equal(cfg.retentionDays, 1);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.roots, ['desktop', 'downloads']);

  const negative = normalizeConfig({ depth: -4, maxChangesPerReport: 1 });
  assert.equal(negative.depth, 0);
  assert.equal(negative.maxChangesPerReport, 10);
});

test('normalizeConfig 丢弃非字符串根，忽略未知字段', () => {
  const cfg = normalizeConfig({ roots: ['desktop', 42, '  '], extraRoots: null, mystery: 1 });
  assert.deepEqual(cfg.roots, ['desktop']);
  assert.deepEqual(cfg.extraRoots, []);
  assert.equal('mystery' in cfg, false);
});

test('expandHome 展开 %USERPROFILE% 与 ~', () => {
  withTempHome((home) => {
    assert.equal(expandHome('%USERPROFILE%\\Desktop').toLowerCase(), path.join(home, 'Desktop').toLowerCase());
    assert.equal(expandHome('~/Docs').toLowerCase(), path.join(home, 'Docs').toLowerCase());
    assert.equal(expandHome(''), '');
    assert.equal(expandHome(null), '');
  });
});

test('resolveRoots 优先命中真实存在的别名目录，并在缺失时回落到第一别名', () => {
  withTempHome((home) => {
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    fs.mkdirSync(path.join(home, 'OneDrive', 'Desktop'), { recursive: true });
    const roots = resolveRoots(normalizeConfig({ roots: ['desktop', 'downloads'], extraRoots: [] }));
    const desktop = roots.find((r) => r.id === 'desktop');
    assert.equal(desktop.exists, true);
    assert.equal(path.basename(desktop.path), 'Desktop');
    assert.equal(path.dirname(desktop.path).toLowerCase(), home.toLowerCase());

    const downloads = roots.find((r) => r.id === 'downloads');
    assert.equal(downloads.exists, false);
    assert.equal(path.basename(downloads.path), 'Downloads');
  });
});

test('resolveRoots 支持 id=路径 与绝对路径，并按路径去重', () => {
  withTempHome((home) => {
    const custom = path.join(home, 'Custom', 'Desk');
    fs.mkdirSync(custom, { recursive: true });
    const roots = resolveRoots(
      normalizeConfig({
        roots: [`desk=${custom}`, custom, home],
        extraRoots: [custom],
      }),
    );
    assert.equal(roots.length, 2);
    assert.equal(roots[0].id, 'desk');
    assert.equal(roots[0].path.toLowerCase(), custom.toLowerCase());
    assert.equal(roots[0].exists, true);
    assert.equal(roots[1].path.toLowerCase(), path.win32.normalize(home).toLowerCase());
  });
});

test('stateDir 跟随 DSH_HOME', () => {
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = 'D:\\tmp\\dsh-home-x';
  try {
    assert.equal(dshHome(), 'D:\\tmp\\dsh-home-x');
    assert.equal(stateDir(), 'D:\\tmp\\dsh-home-x\\state\\aftermath');
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});
