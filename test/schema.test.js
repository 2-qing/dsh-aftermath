import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  FIELD_DEFAULTS,
  SCHEMA_SOURCE,
  installDirCandidates,
  loadSchemastery,
  resolutionBases,
} from '../lib/schema.js';

const FIELD_NAMES = [
  'enabled',
  'roots',
  'depth',
  'retentionDays',
  'maskHome',
  'extraRoots',
  'exclude',
  'maxEntries',
  'maxChangesPerReport',
];

const norm = (list) => list.map((dir) => dir.replace(/\\/g, '/'));

test('resolutionBases 把 DSH 告知的目录纳入搜索根（link: 安装的根因）', () => {
  const bases = resolutionBases({
    DSH_PROFILE_DIR: 'C:/profile-outside',
    DSH_INSTALL_DIR: 'C:/install/dsh',
    DSH_HOME: 'C:/home',
  });
  assert.ok(bases.includes('C:/profile-outside'), 'profile 目录必须在候选根里');
  assert.ok(bases.includes('C:/install/dsh'), '安装目录必须在候选根里');
  assert.ok(bases.some((dir) => dir.replace(/\\/g, '/').endsWith('/lib')));
});

test('resolutionBases 去重且忽略空值', () => {
  const bases = resolutionBases({ DSH_PROFILE_DIR: 'A', DSH_INSTALL_DIR: '', DSH_HOME: undefined });
  assert.equal(bases.filter((dir) => dir === 'A').length, 1);
  assert.equal(bases.includes(''), false);
  assert.equal(bases.includes(undefined), false);
});

test('installDirCandidates 从 exe 位置推 asar 内的 node_modules', () => {
  const dirs = installDirCandidates({
    execPath: 'C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe',
    resourcesPath: 'C:\\Apps\\DeepSeek Harness\\resources',
  });
  const got = norm(dirs);
  assert.ok(
    got.includes('C:/Apps/DeepSeek Harness/resources/app.asar/dsh/node_modules'),
    'asar 内的依赖目录要能被推出来（Desktop 版唯一稳定的 schemastery 来源）',
  );
  assert.ok(got.includes('C:/Apps/DeepSeek Harness/resources/app/dsh/node_modules'));
  assert.equal(new Set(got).size, got.length, '候选目录要去重');
});

test('installDirCandidates 拿不到运行时位置时返回空数组', () => {
  assert.deepEqual(installDirCandidates({ execPath: undefined, resourcesPath: undefined, resources: null }), []);
});

test('Config 是可直接实例化的 schema，且全部字段 volatile', (t) => {
  if (!loadSchemastery()) {
    t.skip('本机解析不到 @deepseek-ai/schemastery');
    return;
  }
  assert.equal(typeof Config, 'function', 'link: 安装时这里曾经变成 undefined，导致设置页只能改总开关');
  const instance = Config({});
  for (const name of FIELD_NAMES) {
    assert.ok(instance[name], `${name} 字段缺失`);
    assert.equal(typeof instance[name].get, 'function', `${name} 必须是 volatile（可用 get() 读）`);
  }
  assert.equal(instance.enabled.get(), FIELD_DEFAULTS.enabled);
  assert.equal(instance.depth.get(), FIELD_DEFAULTS.depth);
  assert.deepEqual(instance.roots.get(), FIELD_DEFAULTS.roots);
});

test('SCHEMA_SOURCE 与是否加载到 schema 一致', () => {
  const loaded = loadSchemastery();
  assert.equal(SCHEMA_SOURCE, loaded ? loaded.source : null);
  assert.equal(typeof Config, loaded ? 'function' : 'undefined');
});