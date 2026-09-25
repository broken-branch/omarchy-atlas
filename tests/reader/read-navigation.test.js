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

test('Enter on a focused neighbour row opens its target for reading', async () => {
  const {neighbourReadTarget} = await app;
  const target = {root:'alpha', path:'docs/guide.md'};
  const entries = [{target}, {target:null}];
  assert.deepEqual(neighbourReadTarget(entries, '0', 'Enter'), target);
  assert.equal(neighbourReadTarget(entries, '0', ' '), null);
  assert.equal(neighbourReadTarget(entries, '1', 'Enter'), null);
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

test('key facts read KeyboardEvent properties from its prototype', async () => {
  const {keyFacts, shortcutFor} = await app;
  const event = Object.create({key:'d', ctrlKey:false, metaKey:false, altKey:false, isComposing:false});
  assert.equal(shortcutFor(keyFacts(event, false), 'read'), 'details');
});

test('reader shell keeps title and fixed header/action placement', () => {
  const html = fs.readFileSync(path.join(root, 'reader/index.html'), 'utf8');
  assert.match(html, /<title>Atlas Reader<\/title>/);
  assert.match(html, /← Back<\/button><button id="forward-button"[^>]*>Forward →/);
  assert.match(html, /Files o<\/button><button id="neighbourhood-button"[^>]*>Neighbourhood n<\/button><button id="map-button">Whole map m/);
  assert.match(html, /Previous file<\/button><button id="next-file"[^>]*>Next file/);
  assert.match(html, /data-action="map">Map m<\/button><button data-action="edit">Edit e<\/button><button data-action="details">Details d/);
  assert.doesNotMatch(html, /id="read-button"|id="facts-button"/);
});

test('map Details toggles the facts drawer for the same file', async () => {
  const {detailsShouldClose} = await app;
  const target = {root:'alpha', path:'docs/guide.md'};
  assert.equal(detailsShouldClose('facts', target, target), true, 'same open target closes Details');
  assert.equal(detailsShouldClose('facts', target, {root:'alpha', path:'README.md'}), false, 'another target opens or replaces Details');
  assert.equal(detailsShouldClose(null, target, target), false, 'closed drawer opens Details');
  const sourceText = fs.readFileSync(path.join(root, 'reader/app.js'), 'utf8');
  assert.match(sourceText, /else if \(action === 'details'\) toggleFacts\(target, opener\)/, 'Details button uses the shared toggle');
  assert.match(sourceText, /details:\(\) => toggleFacts\(selected \|\| route\.target, document\.activeElement\)/, 'reader d key uses the shared toggle');
  assert.equal((sourceText.match(/onDetails:target => toggleFacts/g) || []).length, 1, 'the shared map instance wires Details');
  assert.doesNotMatch(sourceText, /onMap:/, 'restoring onMap recreates the neighbourhood footer route');
});

test('changing the header Whole map target back to the active file ignores a selected neighbour', async () => {
  const {wholeMapTarget} = await app;
  const active = {root:'alpha', path:'docs/guide.md'}, neighbour = {root:'alpha', path:'README.md'};
  assert.deepEqual(wholeMapTarget(active, neighbour, true), neighbour);
  assert.deepEqual(wholeMapTarget(active, neighbour, false), active);
  assert.deepEqual(wholeMapTarget(active, null, true), active);
  assert.match(source, /\$\('map-button'\)\.onclick = openWholeMap/, 'header Whole map uses the selected-neighbour route');
  assert.match(source, /map:openWholeMap/, 'm uses the same selected-neighbour route as the header');
});

test('map camera changes replace the current map history entry before browser history navigation', () => {
  assert.match(source, /onViewChange:\(\) => \{ if \(route\.view === 'map'\) saveVisit\(\); \}/,
    'removing the map view callback leaves Forward without the saved camera');
});

// Run the real app controller with DOM/transport boundaries supplied by the test.
async function navigationHarness(options = {}) {
  const vm = require('node:vm');
  const nodes = new Map(), listeners = {}, windowListeners = {}, instances = [], serverEvents = {};
  const target = options.target || {root:'demo', path:'start.md'};
  function node(id) {
    // textContent and innerHTML are two views of one content, as in the DOM.
    if (!nodes.has(id)) nodes.set(id, {id, hidden:false, value:'', dataset:{}, scrollLeft:0, scrollTop:0, content:'',
      get textContent() { return this.content.replace(/<[^>]*>/g, ''); }, set textContent(value) { this.content = String(value); },
      get innerHTML() { return this.content; }, set innerHTML(value) { this.content = String(value); },
      classList:{values:new Set(), toggle(name, value) { value ? this.values.add(name) : this.values.delete(name); }},
      attributes:{}, setAttribute(key, value) { this.attributes[key] = value; },
      querySelectorAll:() => [], querySelector:() => null, closest:() => null, contains:() => false,
      focus() {}, scrollTo(x, y) { this.scrollLeft = x; this.scrollTop = y; }, insertAdjacentHTML() {}});
    return nodes.get(id);
  }
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
  Object.assign(documentNode, {getElementById:node, querySelector:() => ({}), activeElement:node('reading'), documentElement:{}, closest:() => null});
  const addListener = documentNode.addEventListener.bind(documentNode);
  documentNode.addEventListener = (name, fn, ...rest) => { if (name === 'keydown' && !listeners.keydown) listeners.keydown = fn; addListener(name, fn, ...rest); };
  const context = {URL, URLSearchParams, console, history, location,
    sessionStorage:{getItem:() => null, setItem() {}},
    getComputedStyle:() => ({getPropertyValue:() => ''}),
    document:documentNode,
    window:{markdownit:vendor.markdownit, mermaid:{initialize() {}}, addEventListener(name, fn) { windowListeners[name] = fn; }},
    EventSource:class {addEventListener(name, fn) { serverEvents[name] = fn; } close() {}},
    fetch:async url => {
      if (url !== '/api/index') {
        options.onFileRequest?.(node, url);
        if (options.fileStatus) return {ok:false, status:options.fileStatus, json:async () => ({error:'file request failed'})};
      }
      return {ok:true, json:async () => url === '/api/index' ? {files:[target], roots:['demo']} : options.fileData || {file:{...target,title:'Start'}, content:'# Start\n\nBody text', references:{inbound:[],outbound:[]}}};
    },
    mapModuleStub:{createMap(container, mapOptions) {
      documentNode.addEventListener('keydown', event => { options.onMapKey?.(event); });
      const instance = {container, scope:null, selected:null, visible:false,
        setIndex() {}, setScope(value) { this.scope = value; }, setTarget(value) { this.selected = value; },
        setVisible(value) { this.visible = value; }, getView() { return {selected:this.selected, zoom:2, center:{x:3,y:4}}; },
        setView(value) { this.selected = value.selected; }, setTheme() {}, focusSearch() { this.controlsHidden = false; this.searchFocused = true; }, destroy() {}};
      instances.push(instance); return instance;
    }}
  };
  vm.createContext(context);
  vm.runInContext(source.replace(/export /g, '').replace("import('./map.js')", 'Promise.resolve(mapModuleStub)'), context);
  await context.startApp();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {node, history, instances, target, entries, async key(key) { listeners.keydown({key, target:node('reading'), preventDefault() {}, stopImmediatePropagation() {}}); await settle(); },
    async dispatchKey(key) { class KeyboardEvent extends Event { constructor(type, init) { super(type, {cancelable:true}); this.key = init.key; this.ctrlKey = this.metaKey = this.altKey = this.isComposing = false; } } documentNode.dispatchEvent(new KeyboardEvent('keydown', {key})); await settle(); },
    async click(id) { await node(id).onclick({currentTarget:node(id)}); await settle(); },
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
