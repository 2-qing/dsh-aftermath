import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { VERSION } from '../lib/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('VERSION 与 package.json 一致（防止再次各改各的）', () => {
  assert.equal(VERSION, pkg.version);
});

test('VERSION 不是占位值', () => {
  assert.notEqual(VERSION, '0.0.0', '读不到 package.json，说明路径或打包配置有问题');
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('源码里不再有硬编码的版本号', () => {
  const files = ['index.js', 'commands.js', 'report.js', 'store.js'];
  for (const file of files) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    assert.equal(
      /['"`]v?\d+\.\d+\.\d+['"`]/.test(source),
      false,
      `lib/${file} 里还有硬编码版本号，请改用 lib/version.js 导出的 VERSION`,
    );
  }
});