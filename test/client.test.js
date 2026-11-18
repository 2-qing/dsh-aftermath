import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function fakeReact() {
  return {
    createElement: (type, props) => ({ type, props }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
  };
}

let cached = null;

/** 载入浏览器侧模块，返回它向 __ModuleLoader__ 注册的定义（ESM 只执行一次，故缓存）。 */
async function loadClient() {
  if (cached) return cached;
  let definition = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        definition = def;
      },
    },
  };
  await import('../lib/client.js');
  assert.ok(definition, 'client.js 应该调用 window.__ModuleLoader__.load');
  cached = definition;
  return definition;
}

test('manifest：声明了浏览器入口与 client 平台', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  assert.ok(pkg.files.includes('lib'));
});

test('client.js 不 import 任何 Harness 客户端包（只用注入的 react 与主题 token）', () => {
  const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  assert.equal(source.includes('@deepseek-ai/'), false, '不应出现 Harness 客户端包引用');
  assert.ok(source.includes("require('react')"));
  assert.ok(source.includes('var(--dsw-alias-'), '样式必须走主题 token');
});

test('模块 id 与包名一致，且注册 Plugins 页的配置卡片', async () => {
  const definition = await loadClient();
  assert.equal(definition.id, 'dsh-aftermath');

  const exports = definition.factory((specifier) => {
    assert.equal(specifier, 'react');
    return fakeReact();
  });

  assert.equal(exports.name, 'dsh-aftermath/client');
  assert.deepEqual(exports.inject, ['locale', 'slots']);

  const registered = [];
  const effects = [];
  const scope = { getSnapshot: () => ({ status: 'ready', value: {}, writable: true }), set: async () => true, subscribe: () => () => {} };
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['configForms']);
      callback({ configForms: { get: (key) => (key === 'dsh-aftermath' ? scope : null) } });
    },
    get() {
      return undefined;
    },
    effect(fn, label) {
      effects.push(label);
      const dispose = fn();
      assert.equal(typeof dispose, 'function');
      return dispose;
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'plugins.bundle.config');
        return factory();
      },
      register(slot, component) {
        registered.push({ slot, component });
        return () => {};
      },
    },
  };

  exports.apply(ctx);

  assert.equal(registered.length, 1, '应该只注册一张卡片');
  const { slot, component } = registered[0];
  assert.equal(slot.name, 'plugins.bundle.config');
  assert.equal(slot.key, 'dsh-aftermath', 'key 必须是包名，设置页据此配对');
  assert.equal(slot.locale, 'aftermath');
  assert.equal(typeof component, 'function');
  const props = slot.inject();
  assert.equal(props.scope, scope);
  assert.equal(props.ctx, ctx);
  assert.equal(props.t, undefined, '不应在 inject 里注入 t，否则会覆盖宿主坐席的 t（切换语言不再触发重绘）');
  assert.ok(effects.some((label) => String(label).includes('dictionaries')), '词典应随 effect 注册并可撤销');
});

test('宿主不提供 configForms / slots 时不抛异常', async () => {
  const definition = await loadClient();
  const exports = definition.factory(() => fakeReact());
  const ctx = {
    inject() {},
    get() {
      throw new Error('no services');
    },
    effect(fn) {
      fn();
    },
    locale: {
      register() {
        throw new Error('no locale');
      },
    },
  };
  assert.doesNotThrow(() => exports.apply(ctx));
});
