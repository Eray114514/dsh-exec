/* Offline client-half test: no browser, no React, no desktop.
 *
 * The client bundle is a `window.__ModuleLoader__.load({id, factory})` call, so
 * it can be evaluated in a bare VM context. React is replaced by a stub that
 * records the element tree, which is enough to prove:
 *   - the bundle parses and registers under the right id
 *   - apply() registers a settings.section and registers the zh/en dictionaries
 *   - the section component renders without throwing, in both languages
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.resolve(__dirname, '..', 'client.js');
const source = fs.readFileSync(CLIENT, 'utf8');

const loaded = [];
const styleTags = [];

const sandbox = {
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.reject(new Error('no network in tests')),
  document: {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '' };
      styleTags.push(tag);
      return tag;
    },
    head: { appendChild: () => {} },
  },
  window: { __ModuleLoader__: { load: (def) => loaded.push(def) } },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.equal(loaded.length, 1, 'the bundle must call __ModuleLoader__.load once');
const definition = loaded[0];
assert.equal(definition.id, 'dsh-exec', 'the module id must match the package name');
assert.equal(typeof definition.factory, 'function');

/* A React stub: enough of the API the component actually uses. */
const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(),
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
};

const mod = definition.factory((name) => {
  assert.equal(name, 'react', 'the only module required is react');
  return react;
});
assert.ok(styleTags.length >= 1, 'the CSS block is injected when the module is built');
assert.match(styleTags[0].textContent, /\.dshex/, 'the stylesheet is scoped to dshex');
assert.equal(typeof mod.apply, 'function');
assert.equal(JSON.stringify(mod.inject), '["slots"]', 'only slots is injected');

/* Render every string in the tree so text assertions are simple. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

function render(lang) {
  const dict = lang === 'zh' ? { nav: '命令行执行', defaultsTitle: '默认设置', save: '保存' } : {};
  const registered = [];
  const sections = [];
  const locale = {
    register: (ns, dictionaries) => {
      registered.push({ ns, dictionaries });
    },
    bind: (ns) => (key, params) => {
      const table = lang === 'zh' ? registered[0].dictionaries.zh : registered[0].dictionaries.en;
      let value = table[key] != null ? table[key] : key;
      if (params) for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
      return value;
    },
  };
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    effect: (fn) => fn(),
    inject: (deps, cb) => cb({ slots: { inject: (slot, fn) => fn(), register: (section, view) => sections.push({ section, view }) } }),
  };
  mod.apply(ctx);
  assert.equal(registered.length, 1, 'dictionaries are registered exactly once');
  assert.equal(registered[0].ns, 'dsh-exec');
  assert.ok(Object.keys(registered[0].dictionaries.zh).length > 20, 'a real Chinese dictionary is shipped');
  assert.ok(Object.keys(registered[0].dictionaries.en).length > 20, 'a real English dictionary is shipped');
  for (const key of Object.keys(registered[0].dictionaries.en)) {
    assert.ok(
      registered[0].dictionaries.zh[key] !== undefined,
      `missing Chinese translation for "${key}"`,
    );
  }
  assert.equal(sections.length, 1, 'one settings section is registered');
  const { section, view } = sections[0];
  assert.equal(section.name, 'settings.section');
  assert.equal(section.id, 'dsh-exec');
  assert.equal(section.locale, 'dsh-exec', 'the section label is localised by the host');
  assert.equal(typeof section.label(), 'string');

  const element = view();
  assert.equal(typeof element.type, 'function', 'the view returns a component descriptor');
  const tree = element.type(element.props);
  return { tree, text: textOf(tree), dict, nav: section.label() };
}

const en = render('en');
assert.match(en.text, /DSH Exec/);
assert.match(en.text, /Defaults/);
assert.match(en.text, /dshx "TASK"/, 'the page shows a copy-pasteable command');
assert.match(en.text, /429/, 'the 429 explanation is on the page');

const zh = render('zh');
assert.equal(zh.nav, '命令行执行', 'the settings tab label is translated');
assert.match(zh.text, /默认设置/, 'the Chinese dictionary is used for the body');
assert.match(zh.text, /完全访问/, 'permission options are translated');
assert.match(zh.text, /恢复配置默认值/);

// The permission warning is conditional: it only appears for full access.
const full = zh.tree;
assert.doesNotMatch(textOf(full), /不建议设为默认值/, 'the warning must not show for the default policy');

console.log('OK: dsh-exec client bundle assertions passed');
