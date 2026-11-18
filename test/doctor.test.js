import assert from 'node:assert/strict';
import test from 'node:test';

import { doctorText } from '../lib/commands.js';

const probe = (over) => ({
  at: '2026-11-18T10:00:00.000Z',
  plugin: 'dsh-aftermath',
  version: '0.2.3',
  configExported: true,
  schemaSource: 'C:/profile/desktop',
  namespaces: [{ ns: 'dsh-aftermath', fields: ['enabled', 'depth'] }, { ns: 'other', fields: ['x'] }],
  ourNamespace: true,
  error: null,
  ...over,
});

test('doctor 在命名空间就绪时说明可以编辑全部字段', () => {
  const text = doctorText({ probeSettings: () => probe() });
  assert.match(text, /Config 导出：是/);
  assert.match(text, /设置命名空间：已就绪/);
  assert.match(text, /宿主可见命名空间（2）：dsh-aftermath, other/);
  assert.match(text, /schema 来源：C:\/profile\/desktop/);
});

test('doctor 在命名空间缺失时直接点明只剩总开关，并给出原因', () => {
  const text = doctorText({
    probeSettings: () => probe({ ourNamespace: false, error: '宿主没有为 dsh-aftermath 建立设置命名空间：Config 未导出' }),
  });
  assert.match(text, /设置命名空间：缺失，卡片只能改总开关/);
  assert.match(text, /问题：.*Config 未导出/);
});

test('doctor 在拿不到 probeSettings 时不抛异常', () => {
  const text = doctorText({});
  assert.match(text, /dsh-aftermath/);
  assert.match(text, /拿不到自检结果/);
});

test('doctor 报告的自检快照路径指向状态目录', () => {
  const text = doctorText({ probeSettings: () => probe() });
  assert.match(text, /自检快照：.*settings-probe\.json/);
});