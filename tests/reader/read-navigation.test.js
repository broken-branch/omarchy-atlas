const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'reader/app.js'), 'utf8');
const app = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('file picker scopes and searches path or title in stable root/path order', async () => {
  const {matchingFiles} = await app;
  const files = [
    {root:'zeta', path:'notes/start.md', title:'Welcome'},
    {root:'alpha', path:'docs/guide.md', title:'Reader Guide'},
    {root:'alpha', path:'README.md', title:'Start here'},
    {root:'alpha', path:'settings.toml', title:'settings.toml'}
  ];
  assert.deepEqual(matchingFiles(files, 'alpha', '').map(file => file.path), ['docs/guide.md', 'README.md', 'settings.toml']);
  assert.deepEqual(matchingFiles(files, null, 'start').map(file => `${file.root}/${file.path}`), ['alpha/README.md', 'zeta/notes/start.md']);
});

test('previous and next file only use the captured picker list', async () => {
  const {adjacentFile} = await app;
  const files = [{root:'a', path:'1.md'}, {root:'a', path:'2.toml'}, {root:'b', path:'1.bin'}];
  assert.equal(adjacentFile(files, files[1], -1), files[0]);
  assert.equal(adjacentFile(files, files[1], 1), files[2]);
  assert.equal(adjacentFile(files, files[0], -1), null);
  assert.equal(adjacentFile([], files[0], 1), null);
});

test('history high-water survives reload and resets when forward history is replaced', async () => {
  const {historyHighWater} = await app;
  const values = new Map();
  const storage = {getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value)};
  assert.equal(historyHighWater(storage, 0, true), 0);
  assert.equal(historyHighWater(storage, 2, true), 2);
  assert.equal(historyHighWater(storage, 0), 2, 'reload on an earlier entry retains Forward');
  assert.equal(historyHighWater(storage, 1, true), 1, 'new navigation discards the old forward branch');
  assert.equal(historyHighWater(storage, 0), 1);
});

test('reader and map key assignments preserve native inputs and retire brackets', async () => {
  const {isTextEntry, shortcutFor} = await app;
  const key = (value, view = 'read', extra = {}) => shortcutFor({key:value, editable:false, ctrlKey:false, metaKey:false, altKey:false, isComposing:false, ...extra}, view);
  assert.equal(key('o'), 'files'); assert.equal(key('m'), 'map'); assert.equal(key('n'), 'neighbourhood');
  assert.equal(key('d'), 'details'); assert.equal(key('e'), 'edit'); assert.equal(key('t'), 'outline'); assert.equal(key('b'), 'backlinks'); assert.equal(key('r'), 'refresh'); assert.equal(key('/'), 'search');
  assert.equal(key('Backspace'), 'back'); assert.equal(key('h'), 'back'); assert.equal(key('ArrowLeft'), 'back'); assert.equal(key('l', 'map'), 'activate'); assert.equal(key('ArrowRight', 'map'), 'activate');
  assert.equal(key('j', 'map'), 'next'); assert.equal(key('k', 'map'), 'previous');
  assert.equal(key('z'), 'toolbar'); assert.equal(key('z', 'map'), 'toolbar');
  assert.equal(key('['), null); assert.equal(key(']'), null);
  const target = tag => ({closest: selector => selector.split(', ').some(part => part === tag) ? {} : null});
  const button = target('button'), input = target('input');
  assert.equal(isTextEntry(button), false, 'adding button to the text-entry selector silences action-row shortcuts');
  assert.equal(key('e', 'read', {editable:isTextEntry(button), target:button}), 'edit', 'e works from a focused action-row button');
  assert.equal(key('m', 'read', {editable:isTextEntry(button), target:button}), 'map', 'm works from a focused action-row button');
  assert.equal(key('d', 'read', {editable:isTextEntry(button), target:button}), 'details', 'd works from a focused action-row button');
  assert.equal(key('Escape', 'read', {editable:isTextEntry(button), target:button}), 'escape', 'Escape restores content focus from a button');
  assert.equal(key('m', 'read', {editable:isTextEntry(input), target:input}), null, 'removing input from the text-entry selector leaks letter shortcuts');
  assert.equal(key('m', 'read', {altKey:true}), null); assert.equal(key('Escape', 'read', {editable:true}), 'escape');
});

test('reader shell names views and marks key hints as decorative', () => {
  const html = fs.readFileSync(path.join(root, 'reader/index.html'), 'utf8');
  assert.match(html, /<title>Atlas Reader<\/title>/);
  assert.match(html, /id="toc" role="navigation"/);
  assert.match(html, /id="map-button" aria-keyshortcuts="m">Whole map <span aria-hidden="true">m/);
});

test('toolbar button, handle, z key, and persistence work on reader and map', async () => {
  const values = new Map();
  const storage = {getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value)};
  const h = await navigationHarness({localStorage:storage});
  await h.click('hide-toolbar');
  assert.equal(h.node('toolbar').hidden, true);
  assert.equal(h.node('show-toolbar').hidden, false);
  assert.equal(h.bodyClasses.has('toolbar-hidden'), true);
  assert.equal(h.focused(), 'show-toolbar');
  assert.equal(h.node('show-toolbar').attributes['aria-expanded'], 'false');
  assert.equal(values.get('atlas-toolbar-hidden'), 'true');
  await h.click('show-toolbar');
  assert.equal(h.node('toolbar').hidden, false);
  assert.equal(h.bodyClasses.has('toolbar-hidden'), false);
  assert.equal(h.focused(), 'hide-toolbar');
  assert.equal(h.node('hide-toolbar').attributes['aria-expanded'], 'true');
  await h.key('m'); await h.key('z');
  assert.equal(h.node('toolbar').hidden, true);
  assert.equal(h.bodyClasses.has('toolbar-hidden'), true);
  assert.equal(h.focused(), 'hide-toolbar', 'z does not expand the focused handle');
  assert.equal(h.node('map-view').hidden, false);
  const reloaded = await navigationHarness({localStorage:storage});
  assert.equal(reloaded.node('toolbar').hidden, true);
  assert.equal(reloaded.node('show-toolbar').hidden, false);
});

test('toolbar works when localStorage access throws', async () => {
  const storage = {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }};
  const h = await navigationHarness({localStorage:storage});
  await h.key('z'); assert.equal(h.node('toolbar').hidden, true);
  await h.click('show-toolbar'); assert.equal(h.node('toolbar').hidden, false);
});


// Run the real app controller with DOM/transport boundaries supplied by the test.
async function navigationHarness(options = {}) {
  const vm = require('node:vm');
  const nodes = new Map(), listeners = {}, windowListeners = {}, instances = [], serverEvents = {}, loadedLibraries = [], requests = [];
  let focused = 'reading';
  const target = options.target || {root:'demo', path:'start.md'};
  function node(id) {
    // textContent and innerHTML are two views of one content, as in the DOM.
    if (!nodes.has(id)) nodes.set(id, {id, hidden:false, value:'', dataset:{}, scrollLeft:0, scrollTop:0, content:'',
      get textContent() { return this.content.replace(/<[^>]*>/g, ''); }, set textContent(value) { this.content = String(value); },
      get innerHTML() { return this.content; }, set innerHTML(value) { this.content = String(value); },
      classList:{values:new Set(), toggle(name, value) { value ? this.values.add(name) : this.values.delete(name); }, contains(name) { return this.values.has(name); }},
      attributes:{}, setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
      querySelectorAll(selector) { if (id === 'file-list' && selector === '[data-file]') return (this._files || []).map((_, i) => {
        const row = node(`file-${i}`); row.dataset.file = String(i); row.closest = query => query === '[data-file]' ? row : null; return row;
      }); return []; }, querySelector:() => null, closest(selector) { return ((id === 'file-search' || id === 'search') && selector.includes('input')) || (/^file-\d+$/.test(id) && selector === '[data-file]') ? this : null; }, contains:() => false,
      focus() { focused = id; }, scrollTo(x, y) { this.scrollLeft = x; this.scrollTop = y; }, insertAdjacentHTML() {}});
    return nodes.get(id);
  }
  node('reader-actions').innerHTML = fs.readFileSync(path.join(root, 'reader/index.html'), 'utf8').match(/<div class="actions" id="reader-actions">([^]*?)<\/div>/)[1];
  const location = {href:options.href || 'http://localhost/read/demo/start.md', origin:'http://localhost'};
  const entries = [{state:null, url:location.href}]; let at = 0;
  const history = {get state() { return entries[at].state; },
    replaceState(state, _, url) { entries[at] = {state:structuredClone(state), url}; location.href = new URL(url, location.href).href; },
    pushState(state, _, url) { entries.splice(++at); entries.push({state:structuredClone(state), url}); location.href = new URL(url, location.href).href; },
    async back() { if (at) { at--; location.href = new URL(entries[at].url, location.href).href; await windowListeners.popstate({state:this.state}); } },
    async forward() { if (at + 1 < entries.length) { at++; location.href = new URL(entries[at].url, location.href).href; await windowListeners.popstate({state:this.state}); } }};
  const vendor = {atob};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'reader/vendor/markdown-it.min.js'), 'utf8'), vendor);
  const documentNode = new EventTarget();
  const bodyClasses = new Set();
  Object.assign(documentNode, {getElementById:node, querySelector:() => ({}), querySelectorAll:() => [], activeElement:node('reading'), documentElement:{},
    createElement:tag => ({tag, dataset:{}, remove() {}}), head:{append(item) { if (item.tag === 'script') { loadedLibraries.push(item.src); item.onload(); } }},
    body:{classList:{toggle(name, enabled) { enabled ? bodyClasses.add(name) : bodyClasses.delete(name); }}}, closest:() => null});
  const addListener = documentNode.addEventListener.bind(documentNode);
  documentNode.addEventListener = (name, fn, ...rest) => { if (name === 'keydown' && !listeners.keydown) listeners.keydown = fn; addListener(name, fn, ...rest); };
  const context = {URL, URLSearchParams, console, history, location,
    sessionStorage:{getItem:() => null, setItem() {}},
    localStorage:options.localStorage || {getItem:() => null, setItem() {}},
    setInterval:() => 1, clearInterval() {},
    getComputedStyle:() => ({getPropertyValue:() => ''}),
    document:documentNode,
    window:{markdownit:vendor.markdownit, addEventListener(name, fn) { windowListeners[name] = fn; }},
    EventSource:class {addEventListener(name, fn) { serverEvents[name] = fn; } close() {}},
    fetch:async url => {
      requests.push(url);
      if (url !== '/api/index') {
        options.onFileRequest?.(node, url);
        if (options.fileStatus) return {ok:false, status:options.fileStatus, json:async () => ({error:'file request failed'})};
      }
      if (url === '/api/index' && options.indexFailure?.message) return {ok:false, status:503, json:async () => ({error:options.indexFailure.message})};
      return {ok:true, json:async () => url === '/api/index' ? {files:options.indexFiles || [target], roots:['demo'], generatedAt:'2026-09-25T12:00:00Z'} : options.fileData || {file:{...target,title:'Start'}, content:'# Start\n\nBody text', references:{inbound:[],outbound:[]}}};
    },
    mapModuleStub:{createMap(container, mapOptions) {
      documentNode.addEventListener('keydown', event => { options.onMapKey?.(event); });
      const instance = {container, options:mapOptions, scope:null, selected:null, zoom:2, center:{x:3,y:4}, visible:false, indexed:false, indexCalls:0, scopeCalls:0,
        setIndex() { this.indexed = true; this.indexCalls++; }, setScope(value) { this.scope = value; this.scopeCalls++; }, setTarget(value) { if (this.indexed) { this.selected = value; this.center = {x:9,y:10}; } },
        clearSelection() { this.selected = null; mapOptions.onViewChange(); },
        setVisible(value) { this.visible = value; }, getView() { return {selected:this.selected, zoom:this.zoom, center:this.center}; },
        setView(value) { this.selected = value.selected; this.zoom = value.zoom; this.center = value.center; }, setTheme() {}, focusSearch() { this.controlsHidden = false; this.searchFocused = true; }, destroy() {}};
      instances.push(instance); return instance;
    }}
  };
  vm.createContext(context);
  vm.runInContext(source.replace(/export /g, '').replace("import('./map.js')", 'Promise.resolve(mapModuleStub)'), context);
  await context.startApp();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {node, history, instances, target, entries, bodyClasses, loadedLibraries, requests, focused:() => focused, async key(key) { listeners.keydown({key, target:node('reading'), preventDefault() {}, stopImmediatePropagation() {}}); await settle(); },
    async keyOn(id, key) { listeners.keydown({key, target:node(id), preventDefault() {}, stopImmediatePropagation() {}}); await settle(); },
    async dispatchKey(key) { class KeyboardEvent extends Event { constructor(type, init) { super(type, {cancelable:true}); this.key = init.key; this.ctrlKey = this.metaKey = this.altKey = this.isComposing = false; } } documentNode.dispatchEvent(new KeyboardEvent('keydown', {key})); await settle(); },
    async click(id) { await node(id).onclick({currentTarget:node(id)}); await settle(); },
    async clickHint(container, action) {
      assert.match(node(container).innerHTML, new RegExp(`data-action="${action}"[^>]*>[^<]*<span aria-hidden="true">`));
      const button = {dataset:{action}, focus() { focused = action; }};
      const hint = {dataset:{}, closest:selector => selector === '[data-action]' ? button : null};
      await node(container).onclick({target:hint}); await settle();
    },
    async serverEvent(name, data = {}) { serverEvents[name]({data:JSON.stringify(data)}); await settle(); }};
}

test('a document KeyboardEvent reveals hidden map controls through the app handler', async () => {
  let mapListenerCalls = 0;
  const h = await navigationHarness({onMapKey:() => { mapListenerCalls++; }});
  await h.key('m');
  h.instances[0].controlsHidden = true;
  await h.dispatchKey('/');
  assert.equal(h.instances[0].controlsHidden, false);
  assert.equal(h.instances[0].searchFocused, true);
  assert.equal(mapListenerCalls, 0, 'the app owns slash before the map listener');
});

test('ordinary reading defers map libraries and a cold map target survives the first index', async () => {
  const read = await navigationHarness();
  assert.deepEqual(read.loadedLibraries, []);
  assert.equal(read.instances.length, 0);
  const cold = await navigationHarness({href:'http://localhost/map/demo/start.md'});
  assert.deepEqual(JSON.parse(JSON.stringify(cold.instances[0].selected)), cold.target);
  assert.deepEqual(JSON.parse(JSON.stringify(cold.instances[0].center)), {x:9,y:10});
  assert.deepEqual(cold.loadedLibraries, ['/vendor/force-graph.min.js']);
});

test('an intentionally cleared map selection and camera survive an index refresh', async () => {
  const h = await navigationHarness({href:'http://localhost/map/demo/start.md'});
  const map = h.instances[0];
  map.center = {x:77,y:88}; map.clearSelection();
  assert.equal(h.history.state.map.selected, null);
  await h.serverEvent('index');
  assert.equal(map.selected, null);
  assert.deepEqual(JSON.parse(JSON.stringify(map.center)), {x:77,y:88});
});

test('clicking key hint spans activates reader and Details actions', async () => {
  const h = await navigationHarness();
  await h.clickHint('reader-actions', 'edit');
  assert.equal(h.requests.filter(url => url === '/api/edit').length, 1);
  await h.clickHint('reader-actions', 'details');
  assert.equal(h.node('facts').hidden, false);
  await h.clickHint('facts', 'edit');
  assert.equal(h.requests.filter(url => url === '/api/edit').length, 2);
  await h.clickHint('facts', 'details');
  assert.equal(h.node('facts').hidden, true);
  await h.clickHint('reader-actions', 'map');
  assert.equal(h.node('map-view').hidden, false);
});

test('Mermaid files show source without loading a diagram library', async () => {
  const target = {root:'demo', path:'plot.mmd'};
  const h = await navigationHarness({target, href:'http://localhost/read/demo/plot.mmd',
    fileData:{file:{...target,title:'Plot'}, content:'graph LR\nA --> B', references:{inbound:[],outbound:[]}}});
  assert.deepEqual(h.loadedLibraries, []);
  assert.match(h.node('document').innerHTML, /Mermaid diagram, shown as source/);
  assert.match(h.node('document').innerHTML, /graph LR\nA --&gt; B/);
});

test('picker row keys follow the visible rows while the search input keeps native typing', async () => {
  const files = [{root:'demo', path:'start.md', title:'Start'}, {root:'demo', path:'next.md', title:'Next'}];
  const h = await navigationHarness({indexFiles:files});
  await h.click('files-button');
  await h.keyOn('file-0', 'j'); assert.equal(h.focused(), 'file-1');
  await h.keyOn('file-1', 'ArrowUp'); assert.equal(h.focused(), 'file-0');
  h.node('file-search').focus();
  await h.keyOn('file-search', 'j'); assert.equal(h.focused(), 'file-search');
});

test('Details Escape closes its drawer before the map receives the key', async () => {
  let mapKeys = 0;
  const h = await navigationHarness({onMapKey:() => { mapKeys++; }});
  await h.key('m'); await h.key('d');
  assert.equal(h.node('facts').hidden, false);
  await h.dispatchKey('Escape');
  assert.equal(h.node('facts').hidden, true);
  assert.equal(mapKeys, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.instances[0].selected)), h.target);
});

test('index failure remains visible through file reload and clears on recovery', async () => {
  const indexFailure = {message:''};
  const h = await navigationHarness({indexFailure});
  await h.serverEvent('index-error', {error:'cannot read config', generatedAt:'2026-09-25T12:00:00Z'});
  assert.match(h.node('status').textContent, /cannot read config.*Retaining index/);
  await h.serverEvent('file', h.target);
  assert.match(h.node('status').textContent, /cannot read config/);
  indexFailure.message = 'cannot read config';
  await h.serverEvent('index');
  assert.equal(h.node('retry').hidden, false);
  indexFailure.message = '';
  await h.serverEvent('index');
  assert.equal(h.node('status').textContent, '');
});

test('reader load shows a loading line and titles 404, 413 and server errors by cause', async () => {
  for (const [status, title] of [[404,'File missing'], [413,'File too large'], [500,'File unavailable']]) {
    let pending;
    const h = await navigationHarness({fileStatus:status, onFileRequest:node => { pending = node('document').textContent; }});
    assert.equal(pending, 'Loading file…');
    assert.equal(h.node('document-title').textContent, title);
    assert.match(h.node('metadata').innerHTML, /demo\/start\.md/);
    assert.equal(h.node('document').textContent, status === 413 ? 'This file exceeds the 2 MB reader limit.' : status === 404 ? 'The file could not be found.' : 'The server could not load this file.');
  }
});

test('a live file or index reload keeps the open document on screen until its new content arrives', async () => {
  const during = [];
  const h = await navigationHarness({onFileRequest:node => during.push(node('document').textContent)});
  assert.equal(during[0], 'Loading file…', 'opening a file still shows the loading line');
  during.length = 0;
  await h.serverEvent('file', h.target);
  await h.serverEvent('index');
  assert.equal(during.length, 2);
  for (const text of during) assert.match(text, /Body text/);
  assert.equal(h.node('document-title').textContent, 'Start');
});

test('a filename with a byte that is not UTF-8 opens in the reader', async () => {
  const target = {root:'demo', path:'docs/byte-\udcff.md'}, urls = [];
  const h = await navigationHarness({target, href:'http://localhost/read/demo/docs/byte-%FF.md', onFileRequest:(_node, url) => urls.push(url),
    fileData:{file:{...target, title:'Byte name'}, content:'# Byte name\n\n![Image](plot.png)', references:{inbound:[], outbound:[]}}});
  assert.equal(urls[0], '/api/file?root=demo&path=docs%2Fbyte-%FF.md');
  assert.equal(h.node('document-title').textContent, 'Byte name');
  assert.match(h.node('document').innerHTML, /src="\/raw\/demo\/docs\/plot.png"/);
  await h.key('m');
  assert.equal(new URL(h.entries.at(-1).url).pathname, '/map/demo/docs/byte-%FF.md');
});

test('Back from an oversized file returns to the previous map visit', async () => {
  const h = await navigationHarness({fileStatus:413});
  await h.key('m');
  await h.key('l');
  assert.equal(h.node('document-title').textContent, 'File too large');
  await h.key('Backspace');
  assert.equal(h.node('map-view').hidden, false);
  assert.equal(h.node('read-view').hidden, true);
});

test('Details shows instruction cost and groups inbound and outbound references by style', async () => {
  const target = {root:'demo', path:'start.md'};
  const ref = (style, direction) => ({style, line:2, text:'start.md', resolved:true, from:target, to:target});
  const h = await navigationHarness({fileData:{file:{...target,title:'Start',kind:'instruction',time:'today',timeSource:'mtime',inbound:2,outbound:2,dangling:0}, content:'# Start',
    cost:[{agent:'claude',startupTokensApprox:42,referencedTokensApprox:900}], references:{inbound:[ref('markdown'),ref('path')], outbound:[ref('path'),ref('markdown')]}}});
  await h.key('d');
  assert.match(h.node('facts').innerHTML, /<p>claude · ~42 tokens at startup · ~900 referenced<\/p>/);
  assert.match(h.node('facts').innerHTML, /<h3>inbound<\/h3><h4>markdown<\/h4><ul>/);
  assert.match(h.node('facts').innerHTML, /<h4>path<\/h4><ul>/);
  assert.match(h.node('facts').innerHTML, /<h3>outbound<\/h3><h4>path<\/h4><ul>/);
});

test('removing the reader n navigation leaves the document visible instead of the scoped main canvas', async () => {
  const h = await navigationHarness(); await h.key('n');
  assert.equal(h.node('read-view').hidden, true);
  assert.equal(h.node('map-view').hidden, false);
  assert.equal(h.node('neighbourhood').hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.instances[0].scope)), h.target);
  assert.equal(h.node('neighbourhood-button').attributes['aria-pressed'], 'true');
  assert.equal(h.node('map-button').classList.values.has('active'), false);
  assert.deepEqual(h.history.state.map.scope, h.target);
});

test('omitting setScope(null) leaves Whole map scoped on the shared instance', async () => {
  const h = await navigationHarness(); await h.click('neighbourhood-button'); await h.click('map-button');
  assert.equal(h.instances.length, 1); assert.equal(h.instances[0].scope, null);
  assert.equal(h.node('neighbourhood').hidden, true);
  assert.equal(h.node('map-button').classList.values.has('active'), true);
  await h.history.back(); assert.deepEqual(JSON.parse(JSON.stringify(h.instances[0].scope)), h.target);
  await h.key('n'); assert.equal(h.instances[0].scope, null);
});

test('an index event updates the map once when its scope is unchanged', async () => {
  const h = await navigationHarness(); await h.key('n');
  const map = h.instances[0];
  const indexCalls = map.indexCalls, scopeCalls = map.scopeCalls;
  await h.serverEvent('index');
  assert.equal(map.indexCalls - indexCalls, 1);
  assert.equal(map.scopeCalls - scopeCalls, 0);
});

test('restoring a ghost-selected scoped visit keeps Whole map on the active file', async () => {
  const h = await navigationHarness(); await h.key('n');
  h.entries[1].state.map.selected = {id:'ghost:demo:start.md:path:4:missing.md'};
  await h.history.back(); await h.history.forward();
  assert.deepEqual(JSON.parse(JSON.stringify(h.instances[0].selected)), h.entries[1].state.map.selected,
    'the canvas restores the stable ghost id');
  await h.click('map-button');
  assert.equal(new URL(h.entries.at(-1).url).pathname, '/map/demo/start.md');
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state.route.target)), h.target);
});

test('replacing the neighbourhood push with a pane toggle prevents Back restoring the document and scroll', async () => {
  const h = await navigationHarness(); h.node('reading').scrollTop = 240;
  await h.key('n'); await h.history.back();
  assert.equal(h.node('read-view').hidden, false); assert.equal(h.node('neighbourhood').hidden, true);
  assert.equal(h.node('reading').scrollTop, 240);
  await h.history.forward(); assert.equal(h.node('map-view').hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.instances[0].scope)), h.target);
  await h.key('Escape'); assert.equal(h.node('read-view').hidden, false);
});

test('creating a companion graph makes repeated scope visits allocate a second map instance', async () => {
  const h = await navigationHarness(); await h.key('n'); await h.click('map-button');
  await h.history.back(); await h.history.back(); await h.key('n');
  assert.equal(h.instances.length, 1); assert.equal(h.instances[0].container.id, 'map-view');
  const html = fs.readFileSync(path.join(root, 'reader/index.html'), 'utf8');
  assert.equal((html.match(/id="[^\"]*map[^\"]*"/g) || []).length, 2, 'only header map button and main canvas remain');
});

test('a map camera change reported by the map is what Back then Forward restores', async () => {
  const h = await navigationHarness(); await h.key('m');
  const map = h.instances[0];
  Object.assign(map, {zoom:3.5, center:{x:-40, y:12}}); map.options.onViewChange();
  Object.assign(map, {zoom:1, center:{x:0, y:0}});
  await h.history.back(); assert.equal(h.node('read-view').hidden, false);
  await h.history.forward();
  assert.deepEqual(JSON.parse(JSON.stringify({zoom:map.zoom, center:map.center})), {zoom:3.5, center:{x:-40, y:12}});
});
