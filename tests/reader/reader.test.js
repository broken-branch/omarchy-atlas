const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'reader/app.js'), 'utf8');
const app = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const vendor = {atob};
vm.runInNewContext(fs.readFileSync(path.join(root, 'reader/vendor/markdown-it.min.js'), 'utf8'), vendor);
vm.runInNewContext(fs.readFileSync(path.join(root, 'reader/vendor/highlight.min.js'), 'utf8'), vendor);
const target = {root: 'demo', path: 'docs/start.md'};
const destination = {root: 'demo', path: 'guide.md'};
const ref = (style, line, text, to = destination) => ({from: target, to, style, line, text, resolved: !!to, pointer: false});

test('routes preserve Unicode, spaces, anchors and distinct roots', async () => {
  const {routeURL, parseRoute, targetKey} = await app;
  const selected = {root: 'a b', path: 'docs/日本 #.md'};
  assert.deepEqual(parseRoute(routeURL('read', selected, 'next steps')), {view:'read', target:selected, anchor:'next steps'});
  assert.equal(parseRoute('/map').view, 'map');
  assert.ok(parseRoute('/read/root/a%2Fb.md').error);
  assert.notEqual(targetKey({root:'a/b', path:'c'}), targetKey({root:'a', path:'b/c'}));
});

test('a filename byte that is not UTF-8 travels as that byte and round-trips', async () => {
  const {routeURL, parseRoute, fileURL, assetURL, encodePart, decodePart} = await app;
  const selected = {root: 'demo', path: 'docs/byte-\udcff \u{1F480}.md'};
  assert.equal(routeURL('read', selected), '/read/demo/docs/byte-%FF%20%F0%9F%92%80.md');
  assert.deepEqual(parseRoute(routeURL('read', selected)).target, selected);
  assert.equal(fileURL(selected), '/api/file?root=demo&path=docs%2Fbyte-%FF%20%F0%9F%92%80.md');
  assert.equal(assetURL({root: 'demo', path: 'docs/byte-\udcff.md'}, 'a.png'), '/raw/demo/docs/a.png');
  assert.equal(decodePart(encodePart('a\udce6\udc97b')), 'a\udce6\udc97b', 'a truncated sequence stays two bytes');
});

test('assets stay within raw root and unsafe protocols are refused', async () => {
  const {assetURL} = await app;
  assert.equal(assetURL(target, '../images/a b.png'), '/raw/demo/images/a%20b.png');
  assert.equal(assetURL(target, '../../secret.txt'), '');
  assert.equal(assetURL(target, 'javascript:alert(1)'), '');
  assert.equal(assetURL(target, '//remote/image.png'), '');
});

test('real pinned renderer handles constructs and backend link identities', async () => {
  const {createRenderer} = await app;
  const render = createRenderer(vendor.markdownit, vendor.hljs);
  const refs = [ref('markdown', 5, '[Guide](../guide.md#next-steps)'), ref('wikilink', 5, '[[Guide|Wiki guide]]'), ref('path', 5, 'docs/guide.md'), ref('markdown', 7, '[Lost](missing.md)', null), ref('wikilink', 7, '[[Missing]]', null)];
  const result = render(fs.readFileSync(path.join(root, 'tests/fixtures/reader/guide.md'), 'utf8'), target, refs);
  assert.match(result.html, /href="\/read\/demo\/guide.md#next-steps"/);
  assert.match(result.html, /href="\/read\/demo\/guide.md">Wiki guide/);
  assert.match(result.html, /<code><a href="\/read\/demo\/guide.md">docs\/guide.md<\/a><\/code>/);
  assert.equal((result.html.match(/data-missing="true"/g) || []).length, 2);
  assert.match(result.html, /type="checkbox" disabled checked/);
  assert.match(result.html, /type="checkbox" disabled aria/);
  assert.match(result.html, /hljs-string/);
  assert.match(result.html, /<table>/); assert.match(result.html, /<s>Old<\/s>/);
  assert.match(result.html, /src="\/raw\/demo\/docs\/images\/plot.svg"/);
  assert.doesNotMatch(result.html, /<script>/);
  assert.deepEqual(result.headings.map(h => h.id), ['reader-guide', 'next-steps', 'next-steps-1']);
  assert.deepEqual(result.diagrams, ['graph LR\nA --> B\n']);
});

test('bare and fenced paths follow backend targets without guessing', async () => {
  const {createRenderer} = await app;
  const render = createRenderer(vendor.markdownit, vendor.hljs);
  const text = 'See docs/guide.md and docs/guide.md and unknown.md.\n\n```text\ndocs/guide.md [[Guide]]\n```';
  const html = render(text, target, [ref('path', 1, 'docs/guide.md'), ref('path', 1, 'docs/guide.md'), ref('path', 4, 'docs/guide.md')]).html;
  assert.equal((html.match(/href="\/read\/demo\/guide.md"/g) || []).length, 3);
  assert.match(html, /unknown.md/); assert.match(html, /\[\[Guide\]\]/);
  assert.doesNotMatch(html, /href="[^"]*unknown/);
});

test('external links are isolated and direct Mermaid keeps original source', async () => {
  const {createRenderer} = await app;
  const render = createRenderer(vendor.markdownit, vendor.hljs);
  assert.match(render('[Web](https://example.com)', target).html, /target="_blank" rel="noopener noreferrer"/);
  assert.deepEqual(render('graph LR\nA --> B', {...target, path:'a.mmd'}).diagrams, ['graph LR\nA --> B']);
});

test('non-Markdown extension selects a stable highlight language instead of Markdown rendering', async () => {
  const {createRenderer, textLanguage} = await app;
  const render = createRenderer(vendor.markdownit, vendor.hljs);
  const cases = [
    ['.env', 'bash'], ['settings.toml', 'toml'], ['workflow.yml', 'yaml'], ['data.unknown', 'plaintext']
  ];
  for (const [name, language] of cases) {
    assert.equal(textLanguage(name), language);
    const result = render('value = "Atlas"\n', {...target, path:name});
    assert.match(result.html, new RegExp(`<pre><code class="language-${language}">`));
    assert.deepEqual(result.headings, []);
  }
});

test('binary response renders only its byte count instead of passing bytes to the text renderer', async () => {
  const {renderFile} = await app;
  let called = false;
  const result = renderFile({binary:true, bytes:3}, {...target, path:'blob.bin'}, () => { called = true; });
  assert.equal(result.html, '<pre><code>Binary file · 3 bytes</code></pre>');
  assert.deepEqual(result.headings, []);
  assert.equal(called, false);
});

test('theme uses live palette and strict diagrams', async () => {
  const {themeOptions} = await app;
  for (const mode of ['dark', 'light']) {
    const values = {'--mode':mode, '--foreground':mode === 'dark' ? '#eeeeee' : '#111111', '--accent':'#336699'};
    const config = themeOptions(key => values[key] || '#777777');
    assert.equal(config.securityLevel, 'strict');
    assert.equal(config.themeVariables.darkMode, mode === 'dark');
    assert.equal(config.themeVariables.primaryTextColor, values['--foreground']);
  }
});

test('stylesheet load precedes redraw; failure retains last usable stylesheet', async () => {
  const {replaceTheme} = await app;
  for (const fail of [false, true]) {
    const calls = []; let next;
    const old = {after(node) { next = node; calls.push('append'); queueMicrotask(() => fail ? node.onerror() : node.onload()); }, remove() { calls.push('remove-old'); }};
    const doc = {getElementById: () => old, createElement: () => ({remove() { calls.push('remove-new'); }})};
    const promise = replaceTheme(doc, () => calls.push('redraw'));
    if (fail) { await assert.rejects(promise, /retaining previous/); assert.deepEqual(calls, ['append', 'remove-new']); }
    else { await promise; assert.equal(next.id, 'theme'); assert.deepEqual(calls, ['append', 'remove-old', 'redraw']); }
  }
});

test('every child of the reading column shares one width independent of its own font', () => {
  const css = fs.readFileSync(path.join(root, 'reader/app.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({selector: selector.trim(), body}));
  const column = rules.find(rule => rule.selector === '#reading > *');
  assert.match(column.body, /max-width: min\(100%, 42\.5rem\); margin-inline: auto;/);
  const children = fs.readFileSync(path.join(root, 'reader/index.html'), 'utf8').match(/<main id="reading"[^>]*>([\s\S]*?)<\/main>/)[1];
  const selectors = ['.file-step', 'h1', '#document-title', '#metadata', '.actions', '#reader-actions', 'article', '#document', 'footer', '#backlinks'];
  for (const name of selectors) assert.ok(children.includes(name[0] === '#' ? `id="${name.slice(1)}"` : name[0] === '.' ? `class="${name.slice(1)}"` : `<${name}`), name);
  for (const rule of rules) {
    const names = rule.selector.split(',').map(name => name.trim());
    if (names.some(name => selectors.includes(name)))
      assert.doesNotMatch(rule.body, /(^|[\s;])(max-width|width|margin|margin-inline|margin-left):/, rule.selector);
  }
});
