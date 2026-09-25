const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../reader/map.js'), 'utf8');
const map = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const kind = (id, label, colour, paths, extensions) => ({id, label, colour, match:{paths, extensions}, builtin:true, overridden:false});
const kinds = [
  kind('instruction', 'Agent instructions', 'orange', ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'codex.md', 'GEMINI.md', 'CONVENTIONS.md', '.claude/', '.codex/', '.github/copilot-instructions.md', '.github/instructions/*.instructions.md', '.cursor/rules/*.mdc', '.cursorrules', '.windsurf/rules/*.md', '.windsurfrules', '.clinerules', '.clinerules/'], ['.md', '.mmd', '.mermaid']),
  kind('readme', 'Readmes', 'cyan', ['README.md'], ['.md', '.mmd', '.mermaid']),
  kind('decision', 'Decisions', 'magenta', ['docs/adr/', 'decisions.md'], ['.md', '.mmd', '.mermaid']),
  kind('runbook', 'Runbooks', 'yellow', ['runbooks/'], ['.md', '.mmd', '.mermaid']),
  kind('plan', 'Plans', 'bright_blue', ['plans/'], ['.md', '.mmd', '.mermaid']),
  kind('log', 'Logs', 'muted', ['logs/'], ['.md', '.mmd', '.mermaid']),
  kind('archive', 'Archived', 'brown', ['archive/', 'superseded/'], ['.md', '.mmd', '.mermaid']),
  kind('generated', 'Generated', 'foreground', ['docs/generated/'], ['.md', '.mmd', '.mermaid']),
  kind('diagram', 'Diagrams', 'bright_magenta', [], ['.mmd', '.mermaid']),
  kind('doc', 'Documents', 'blue', [], ['.md'])
];
const fixture = {...JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/map/index.json'), 'utf8')), kinds};
const target = {root: 'alpha', path: 'guide.md'};
async function model() { const m = (await map).createModel(); m.setIndex(structuredClone(fixture)); return m; }

test('default graph excludes logs, retains orphan outbound links, and distinguishes same paths', async () => {
  const m = await model(), {fileKey} = await map, data = m.view();
  assert.equal(data.fileCount, 4);
  assert.equal(data.nodes.length, 7);
  assert.equal(data.links.length, 5);
  assert.ok(data.links.some(l => l.source === fileKey({root:'alpha', path:'loose.md'}) && l.target === fileKey(target)));
  assert.notEqual(m.get(target), m.get({root:'beta', path:'guide.md'}));
  assert.notEqual(fileKey({root:'a/b', path:'c'}), fileKey({root:'a', path:'b/c'}));
  m.filters.kinds.add('log');
  assert.equal(m.view().fileCount, 5); assert.equal(m.view().links.length, 6);
});

test('ghosts use occurrence identity; impact source is neither a file nor actionable', async () => {
  const m = await model(), {targetOf, radius, describe} = await map, data = m.view();
  const ghosts = data.nodes.filter(n => n.type === 'ghost');
  assert.equal(new Set(ghosts.map(n => n.id)).size, 2);
  const anchor = data.nodes.find(n => n.type === 'anchor');
  assert.match(describe(anchor), /source, not a document/);
  for (const node of [...ghosts, anchor]) { assert.equal(targetOf(node), null); assert.equal(node.file, undefined); }
  assert.equal(radius(anchor), 4);
  assert.equal(data.links.filter(l => l.style === 'impact').length, 1);
  const ids = ghosts.map(n => n.id);
  m.setIndex({...structuredClone(fixture), generatedAt:'later'});
  assert.deepEqual(m.view().nodes.filter(n => n.type === 'ghost').map(n => n.id), ids);
});

test('root, kind and finding filters compose; no detached ghosts or source anchors', async () => {
  const m = await model(); m.filters.stale = m.filters.dangling = true;
  assert.deepEqual(m.view().nodes.filter(n => n.type === 'file').map(n => n.file.path), ['guide.md']);
  assert.equal(m.view().links.length, 3);
  m.filters.orphan = true; assert.equal(m.view().nodes.length, 0);
  m.filters.stale = m.filters.dangling = false; m.filters.roots = new Set(['beta']);
  assert.equal(m.view().nodes.length, 1); assert.equal(m.view().links.length, 0);
  m.filters.kinds.delete('doc'); assert.equal(m.view().fileCount, 0);
});

test('filter and index refresh preserve object identity, positions and pins without mutating index', async () => {
  const {createModel, togglePin} = await map, m = createModel(), index = structuredClone(fixture), before = JSON.stringify(index);
  assert.equal(m.setIndex(index), true);
  const node = m.get(target); node.x = 41; node.y = 23; togglePin(node);
  // force-graph resolves links into objects; a subsequent view must use clean IDs.
  const data = m.view(); data.links[0].target = node;
  m.filters.kinds.delete('doc'); m.view(); m.filters.kinds.add('doc');
  assert.equal(m.get(target), node); assert.equal(m.view().links[0].target, node.id);
  assert.equal(m.setIndex({...index, generatedAt:'later'}), false);
  const changed = structuredClone(index); changed.files[1].title = 'Updated'; assert.equal(m.setIndex(changed), true);
  assert.equal(m.get(target), node); assert.equal(node.file.title, 'Updated');
  assert.deepEqual([node.x, node.y, node.fx, node.fy], [41, 23, 41, 23]);
  assert.equal(JSON.stringify(index), before);
  changed.files = changed.files.filter(f => f.root !== 'beta'); m.setIndex(changed);
  assert.equal(m.get({root:'beta', path:'guide.md'}), undefined);
});

test('2,000 guard counts root files before kinds/findings and excludes synthetic nodes', async () => {
  const {createModel} = await map, m = createModel();
  const files = Array.from({length:2000}, (_, i) => ({...fixture.files[1], path:`${i}.md`}));
  files[0] = fixture.files[1];
  m.setIndex({...fixture, files});
  assert.equal(m.view().guarded, false); assert.equal(m.view().nodes.length, 2003);
  m.setIndex({...fixture, files:[...files, fixture.files[4]]});
  m.filters.kinds.clear(); assert.equal(m.view().guarded, true); assert.equal(m.view().nodes.length, 0);
  m.filters.roots = new Set(['beta']); m.filters.kinds.add('doc'); assert.equal(m.view().guarded, false); assert.equal(m.view().fileCount, 1);
});

test('search returns real visible path/title matches, including same filenames across roots', async () => {
  const m = await model();
  assert.deepEqual(m.search('GUIDE').map(n => n.root), ['alpha', 'beta']);
  assert.equal(m.search('loose END')[0].file.path, 'loose.md');
  assert.equal(m.search('daily').length, 0); assert.equal(m.search('missing').length, 0); assert.equal(m.search('').length, 0);
  m.filters.roots = new Set(['beta']); assert.equal(m.search('guide').length, 1);
});

test('hover isolates both directions and keeps links with mutated endpoints', async () => {
  const m = await model(), {neighbourhood} = await map, data = m.view(), node = m.get(target);
  data.links[0].target = node;
  const near = neighbourhood(data, node.id);
  assert.equal(near.links.size, 5); assert.equal(near.nodes.size, 6);
  assert.ok(!near.nodes.has(m.get({root:'beta', path:'guide.md'}).id));
  assert.equal(neighbourhood(data, null).nodes.size, 0);
});

test('one-hop scope includes incoming and outgoing files, ghosts and impact anchors while ignoring filters', async () => {
  const m = await model();
  m.filters.roots = new Set(['beta']); m.filters.kinds.clear(); m.filters.stale = true;
  const data = m.view(target);
  assert.equal(data.fileCount, 4);
  assert.equal(data.nodes.length, 7);
  assert.equal(data.links.length, 6);
  assert.ok(data.nodes.some(node => node.file?.kind === 'log'));
  assert.equal(data.nodes.filter(node => node.type === 'ghost').length, 2);
  assert.equal(data.nodes.filter(node => node.type === 'anchor').length, 1);
  assert.deepEqual(data.scope, target);
});

test('inbound radius is logarithmic/clamped, pins toggle, edge styles and theme kind tokens remain distinct', async () => {
  const {radius, togglePin, edgeDash, palette} = await map;
  const n = {type:'file', file:{inbound:0}, x:12, y:24}; assert.equal(radius(n), 5);
  n.file.inbound = 1; assert.equal(radius(n), 8); n.file.inbound = 1000000; assert.equal(radius(n), 19);
  togglePin(n); assert.deepEqual([n.fx,n.fy],[12,24]); togglePin(n); assert.equal(n.fx, undefined);
  assert.deepEqual(['markdown','path','wikilink','impact'].map(edgeDash), [[],[5,4],[1,3],[]]);
  const dark = palette(name => `dark:${name}`, kinds), light = palette(name => `light:${name}`, kinds);
  assert.equal(dark.kinds.plan, 'dark:--bright-blue');
  for (const kind of Object.keys(dark.kinds)) assert.notEqual(dark.kinds[kind], light.kinds[kind]);
  assert.notEqual(dark.stale, light.stale);
});

test('layout reports alpha convergence before the cooldown cap and rejects capped timing', async () => {
  const {settleResult} = await map;
  assert.deepEqual(settleResult(917, 1800), {settleMs:917, settleReason:null});
  assert.deepEqual(settleResult(1800, 1800), {settleMs:null, settleReason:'cooldown-cap'});
  assert.deepEqual(settleResult(1813, 1800), {settleMs:null, settleReason:'cooldown-cap'});
});

test('changing the 12 multiplier makes the 45-file cluster ring less than three times the old 35', async () => {
  const {clusterRadius} = await map;
  assert.ok(clusterRadius(45) >= 35 * 3);
});

test('removing the fixed 110 offset puts an orphan on the ordinary cluster ring', async () => {
  const {clusterForce, clusterRadius} = await map;
  const ordinary = {root:'alpha', type:'file', file:{orphan:false}, x:0, y:0, vx:0, vy:0};
  const orphan = {root:'alpha', type:'file', file:{orphan:true}, x:0, y:0, vx:0, vy:0};
  const force = clusterForce(); force.initialize([ordinary, orphan]); force(1);
  assert.ok(Math.hypot(orphan.vx, orphan.vy) > clusterRadius(2) * .008);
});

test('removing the radius-aware orbit lets two large root cluster rings overlap', async () => {
  const {clusterLayout} = await map;
  const nodes = ['alpha', 'beta'].flatMap(root => Array.from({length:900}, () => ({root, type:'file'})));
  const layout = clusterLayout(nodes), alpha = layout.get('alpha'), beta = layout.get('beta');
  assert.ok(Math.hypot(alpha.x - beta.x, alpha.y - beta.y) >= alpha.radius + beta.radius);
});

// A small host/engine boundary harness: tests Atlas callbacks and lifecycle,
// not browser canvas rendering or force-graph's own layout implementation.
function host() {
  const listeners = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {setProperty(k, v){ this[k] = v; }}; this.classList = {add(){}, remove(){}}; this.value = ''; this.clientWidth = 800; this.clientHeight = 600; }
    addEventListener(key, handler) { this.listeners ??= new Map(); this.listeners.set(key, handler); }
    removeEventListener(key) { this.listeners.delete(key); }
    append(el) { el.parentNode = this; this.children.push(el); }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this.attributes[k] = v; }
    focus() { document.activeElement = this; }
    closest(selector) { return selector.split(', ').some(part => part === this.tagName) ? this : null; }
    click() { if (!this.disabled) this.onclick?.({}); }
    getContext() { return {fillStyle: '#112233'}; }
  }
  const document = {createElement: tag => new Element(tag), addEventListener:(k,v) => listeners.set(k,v), removeEventListener:k => listeners.delete(k)};
  const container = new Element('section'); container.ownerDocument = document;
  const settings = {}, calls = [], callArguments = new Map(), forces = new Map(), forceSettings = new Map(); let zoom = 1, centre = {x:0, y:0}, pendingCentre = null, graphData, width = 800, height = 600;
  const graph = new Proxy({}, {get(_, key) {
    if (key === 'd3Force') return (name, value) => {
      if (value !== undefined) { forces.set(name, value); return graph; }
      if (!forces.has(name)) {
        const configured = {}; forceSettings.set(name, configured);
        const force = new Proxy({}, {get(_, setting) {
          return value => { configured[setting] = value; return force; };
        }});
        forces.set(name, force);
      }
      return forces.get(name);
    };
    if (key === 'zoom') return value => { if (value === undefined) return zoom; zoom = value; return graph; };
    if (key === 'centerAt') return (x, y, duration) => {
      if (x === undefined) return {...centre};
      if (duration) pendingCentre = {x, y}; else { centre = {x, y}; pendingCentre = null; settings.onZoomEnd?.(); }
      calls.push(key); return graph;
    };
    if (key === 'width' || key === 'height') return value => {
      const previous = key === 'width' ? width : height, delta = value - previous;
      if (key === 'width') width = value; else height = value;
      if (delta) centre = {...centre, [key === 'width' ? 'x' : 'y']:centre[key === 'width' ? 'x' : 'y'] + delta / 2 / zoom};
      calls.push(key); return graph;
    };
    if (key === 'graphData') return value => {
      graphData = value; value.nodes.forEach((n, i) => { n.x ??= i * 20; n.y ??= i * 10; }); calls.push(key); return graph;
    };
    return (...args) => { settings[key] = args[0]; callArguments.set(key, args); calls.push(key); return graph; };
  }});
  const all = (node = container) => [node, ...node.children.flatMap(c => all(c))];
  return {container, document, settings, calls, callArguments, forces, forceSettings, graph, listeners, all, data:() => graphData,
    stage:() => all().find(element => element.className === 'map-stage'),
    completeCentre() { if (pendingCentre) { centre = pendingCentre; pendingCentre = null; settings.onZoomEnd?.(); } }};
}

test('changing charge -220, distanceMax 500 or link distance 120 leaves the fake graph with old force settings', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:() => '#112233'});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, api = createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    assert.deepEqual(h.forceSettings.get('charge'), {strength:-220, distanceMax:500});
    assert.deepEqual(h.forceSettings.get('link'), {distance:120});
    api.destroy();
  } finally { Object.assign(global, previous); }
});

test('changing the initial 350 ms fit or 40 px padding stops a scoped visit fitting a narrow canvas', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:() => '#112233'});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, api = createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    h.stage().clientWidth = 300;
    api.setIndex(fixture); api.setScope(target); h.settings.onEngineStop();
    assert.deepEqual(h.callArguments.get('zoomToFit'), [350, 40]);
    assert.equal(h.data().nodes.length, 7);
    api.destroy();
  } finally { Object.assign(global, previous); }
});

test('app boundary: selection/read/edit, pin, keyboard, filters and theme preserve state; teardown removes listeners', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  let theme = 'dark', disconnected = false;
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue: name => name === '--font-monospace' ? 'monospace' : `${theme}:${name}`});
  global.ResizeObserver = class { observe() {} disconnect() { disconnected = true; } };
  try {
    const {createMap} = await map, events = [];
    const api = createMap(h.container, {onSelect:t => events.push(['select',t]), onRead:t => events.push(['read',t]), onEdit:t => events.push(['edit',t])});
    assert.equal(h.settings.d3AlphaMin, .1); assert.equal(h.settings.cooldownTime, 1800);
    api.setIndex(fixture); api.setTarget(target);
    const node = h.data().nodes.find(n => n.file?.path === 'guide.md' && n.root === 'alpha');
    h.settings.onNodeClick(node); assert.deepEqual(events.pop(), ['select',target]);
    h.settings.onNodeDragEnd(node); assert.equal(node.fx, node.x);
    h.settings.onNodeRightClick(node, {preventDefault(){}}); assert.equal(node.fx, undefined);
    h.settings.onNodeHover(node);
    assert.equal(h.settings.linkDirectionalArrowLength(h.data().links[0]), 4);
    h.settings.onNodeHover(null); assert.equal(h.settings.linkDirectionalArrowLength(h.data().links[0]), 0);
    // Near nodes draw glyph paths; distant nodes draw circles only. Stale and
    // selected rings coexist, and the pointer region surrounds the visible node.
    const drawing = [], ctx = new Proxy({}, {get:(_, name) => (...args) => drawing.push([name,...args]), set:() => true});
    h.settings.nodeCanvasObject(node, ctx, 2);
    assert.equal(drawing.filter(call => call[0] === 'arc').length, 3);
    assert.ok(drawing.some(call => call[0] === 'lineTo'));
    drawing.length = 0; h.settings.nodeCanvasObject(node, ctx, .1);
    assert.ok(!drawing.some(call => call[0] === 'lineTo'));
    drawing.length = 0; h.settings.nodePointerAreaPaint(node, '#123456', ctx);
    assert.ok(drawing.find(call => call[0] === 'arc')[3] > 10);
    const key = k => h.listeners.get('keydown')({key:k, target:h.container, preventDefault(){}});
    const beforeComposition = events.length;
    h.listeners.get('keydown')({key:'Enter', isComposing:true, target:h.container, preventDefault(){}});
    assert.equal(events.length, beforeComposition);
    key('Enter'); assert.deepEqual(events.pop(), ['read',target]); key('e'); assert.deepEqual(events.pop(), ['edit',target]);
    key('l'); assert.deepEqual(events.pop(), ['read',target]); key('d'); assert.deepEqual(events.pop(), ['select',target]);
    const editButton = h.all().find(element => element.textContent === 'Edit e');
    const beforeNativeEnter = events.length;
    h.listeners.get('keydown')({key:'Enter', target:editButton, preventDefault(){}});
    assert.equal(events.length, beforeNativeEnter, 'removing the focused-control Enter guard double-fires its native action');
    h.listeners.get('keydown')({key:'e', target:editButton, preventDefault(){}});
    assert.deepEqual(events.pop(), ['edit',target], 'excluding buttons from map shortcuts silences letter actions');
    h.listeners.get('keydown')({key:'l', target:editButton, preventDefault(){}});
    assert.deepEqual(events.pop(), ['edit',target], 'l clicks the focused control instead of reading the file');
    const beforeZoom = h.graph.zoom(); key('+'); assert.equal(h.graph.zoom(), beforeZoom * 1.3); key('-'); assert.equal(h.graph.zoom(), beforeZoom);
    const other = h.data().nodes.find(n => n.file?.root === 'beta'); drawing.length = 0; h.settings.nodeCanvasObject(other, ctx, .1);
    assert.ok(!drawing.some(call => call[0] === 'fillText')); key('v'); drawing.length = 0; h.settings.nodeCanvasObject(other, ctx, .1);
    assert.ok(drawing.some(call => call[0] === 'fillText'));
    key('Escape'); key('j'); assert.deepEqual(events.pop(), ['select',{root:'alpha',path:'README.md'}]); api.setTarget(target);
    h.settings.onNodeRightClick(node, {preventDefault(){}}); assert.equal(node.fx, node.x);
    h.graph.zoom(2); const coordinates = [node.x,node.y,node.fx,node.fy]; const graphUpdates = h.calls.filter(c => c === 'graphData').length;
    theme = 'light'; api.setTheme();
    assert.equal(h.settings.backgroundColor, 'light:--background'); assert.equal(h.graph.zoom(), 2);
    assert.equal(h.calls.filter(c => c === 'graphData').length, graphUpdates); assert.deepEqual([node.x,node.y,node.fx,node.fy], coordinates);
    key('Enter'); assert.deepEqual(events.pop(), ['read',target]);
    const docRow = h.all().find(e => e.attributes['data-filter'] === 'doc'); docRow.click(); docRow.click();
    assert.ok(h.data().nodes.includes(node)); assert.equal(node.fx, coordinates[2]);
    const ghost = h.data().nodes.find(n => n.type === 'ghost'); h.settings.onNodeClick(ghost); const count = events.length;
    key('Enter'); key('e'); assert.equal(events.length, count);
    const search = h.all().find(e => e.tagName === 'input'), results = h.all().find(e => e.tagName === 'select');
    search.value = 'other guide'; search.oninput(); assert.equal(results.children.length, 1);
    results.value = results.children[0].value; results.onchange();
    assert.deepEqual(events.pop(), ['select',{root:'beta',path:'guide.md'}]);
    h.all().find(e => e.textContent === 'beta').click();
    h.all().find(e => e.attributes['data-filter'] === 'stale').click();
    api.setTarget({root:'alpha',path:'logs/day.md'});
    assert.ok(!h.data().nodes.some(n => n.file?.kind === 'log'));
    const reveal = h.all().find(e => e.textContent === 'Reveal target'); assert.ok(reveal); reveal.click();
    assert.ok(h.data().nodes.some(n => n.file?.kind === 'log'));
    assert.ok(h.data().nodes.some(n => n.file?.root === 'beta'));
    key('Escape'); const reads = events.length; key('Enter'); assert.equal(events.length, reads);
    api.setVisible(false); assert.ok(h.calls.includes('pauseAnimation')); api.setVisible(true); assert.ok(h.calls.includes('resumeAnimation'));
    api.destroy(); assert.ok(disconnected); assert.equal(h.listeners.size, 0); assert.equal(h.container.children.length, 0); assert.ok(h.calls.includes('_destructor'));
  } finally { Object.assign(global, previous); }
});

test('details key and button prefer onDetails over onSelect when both are provided', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue: name => name === '--font-monospace' ? 'monospace' : `theme:${name}`});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, selected = [], detailed = [];
    const api = createMap(h.container, {onSelect:t => selected.push(t), onRead(){}, onEdit(){}, onDetails:t => detailed.push(t)});
    api.setIndex(fixture); api.setTarget(target);
    h.listeners.get('keydown')({key:'d', target:h.container, preventDefault(){}});
    h.all().find(element => element.textContent === 'Details d').click();
    assert.deepEqual(detailed, [target, target]); assert.deepEqual(selected, []);
    api.destroy();
  } finally { Object.assign(global, previous); }
});

test('removing scoped Last target hiding or restoring footer Map leaves neighbourhood controls in the wrong place', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  let creations = 0;
  global.ForceGraph = () => () => { creations++; return h.graph; };
  global.getComputedStyle = () => ({getPropertyValue: name => name === '--font-monospace' ? 'monospace' : `theme:${name}`});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, api = createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    api.setIndex(fixture); api.setTarget(target);
    const lastTargetAction = h.all().find(element => element.textContent === 'Last target 0');
    assert.equal(lastTargetAction.hidden, false);
    assert.equal(h.all().some(element => element.textContent === 'Map m'), false);
    const selected = h.data().nodes.find(node => node.file?.root === target.root && node.file?.path === target.path);
    selected.fx = 31; selected.fy = 47; h.graph.zoom(1.75); h.graph.centerAt(120, -30);
    const saved = api.getView();
    assert.deepEqual(saved, {controlsHidden:false, zoom:1.75, center:{x:120,y:-30}, selected:target, pins:[{...target,x:31,y:47}]});
    const updates = h.calls.filter(call => call === 'graphData').length;
    api.setView({zoom:2.25, center:{x:-9,y:14}, selected:target, pins:[{...target,x:7,y:11}]});
    assert.equal(h.calls.filter(call => call === 'graphData').length, updates);
    assert.deepEqual(api.getView(), {controlsHidden:false, zoom:2.25, center:{x:-9,y:14}, selected:target, pins:[{...target,x:7,y:11}]});
    api.setScope(target);
    assert.equal(creations, 1); assert.equal(h.data().nodes.length, 7); assert.equal(h.data().links.length, 6);
    assert.ok(h.data().nodes.some(node => node.file?.kind === 'log'));
    assert.equal(h.all().find(e => e.textContent === 'Direct references · all kinds').hidden, false);
    assert.equal(lastTargetAction.hidden, true);
    assert.equal(h.all().some(element => element.textContent === 'Map m'), false);
    api.setScope(null);
    assert.equal(lastTargetAction.hidden, false);
    assert.equal(creations, 1); assert.equal(h.data().links.length, 5);
    api.destroy();
  } finally { Object.assign(global, previous); }
});

async function controlsHost(run) {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  const storage = new Map();
  h.document.defaultView = {sessionStorage:{getItem:key => storage.get(key), setItem:(key, value) => storage.set(key, value)}};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:() => '#112233'});
  let resizeCallback;
  global.ResizeObserver = class { constructor(callback) { resizeCallback = callback; } observe() {} disconnect() {} };
  const events = [];
  const options = {onSelect(){}, onRead:t => events.push(['read', t]), onEdit:t => events.push(['edit', t])};
  const {createMap} = await map;
  let api;
  const start = () => { api = createMap(h.container, options); api.setIndex(fixture); api.setTarget(target); return api; };
  const key = k => h.listeners.get('keydown')({key:k, target:h.document.activeElement || h.container, preventDefault(){}});
  const byClass = name => h.all().find(el => el.className === name);
  const shown = el => !el.hidden && (!el.parentNode || shown(el.parentNode));
  try { await run({h, api:start(), start, key, byClass, shown, events, resize:() => resizeCallback()}); }
  finally { api?.destroy(); Object.assign(global, previous); }
}

test('removing the overlay/footer hidden assignment leaves controls visible instead of one Show controls c button', async () => {
  await controlsHost(({h, key, byClass, shown, events}) => {
    const toggle = byClass('map-controls-toggle');
    assert.equal(toggle.textContent, 'Hide controls c');
    toggle.click();
    for (const name of ['map-search', 'map-graph-controls', 'map-footer']) assert.equal(shown(byClass(name)), false);
    assert.equal(shown(byClass('map-controls')), true);
    assert.equal(shown(byClass('map-filter-controls')), true);
    assert.deepEqual(h.all(byClass('map-canvas')).filter(el => el.tagName === 'button' && shown(el)), [toggle]);
    assert.equal(toggle.textContent, 'Show controls c');
    assert.equal(h.document.activeElement, byClass('map-stage'));
    key('Enter'); key('e'); assert.deepEqual(events, [['read',target], ['edit',target]]);
    key('f'); assert.ok(h.calls.includes('zoomToFit'));
    toggle.click();
    for (const name of ['map-search', 'map-graph-controls', 'map-footer']) assert.equal(shown(byClass(name)), true);
    assert.ok(!h.all().some(el => el.className === 'map-legend'));
  });
});

test('map search method reveals hidden controls and focuses the named input', async () => {
  await controlsHost(({h, api, key, byClass}) => {
    key('c'); assert.equal(byClass('map-footer').hidden, true);
    key('c'); assert.equal(byClass('map-footer').hidden, false);
    key('c'); api.focusSearch();
    assert.equal(byClass('map-search').hidden, false);
    assert.equal(h.document.activeElement.tagName, 'input');
    assert.equal(h.document.activeElement.attributes['aria-label'], 'Path or title');
  });
});

test('omitting controlsHidden from getView or setView loses hidden state on Back/Forward', async () => {
  await controlsHost(({api, key, byClass}) => {
    const visible = api.getView(); key('c'); const hidden = api.getView();
    assert.equal(hidden.controlsHidden, true);
    api.setView(visible); assert.equal(byClass('map-footer').hidden, false);
    api.setView(hidden); assert.equal(byClass('map-footer').hidden, true);
    assert.deepEqual(api.getView(), hidden);
  });
});

test('reading the live camera instead of its destination saves the pre-animation view during a target fly-to', async () => {
  await controlsHost(({h, api}) => {
    const saved = api.getView();
    h.completeCentre();
    assert.deepEqual(saved.center, api.getView().center);
  });
});

test('removing the camera restore after the engine re-centres on resize moves a restored view', async () => {
  await controlsHost(({h, api, key, resize}) => {
    api.setView({zoom:2.25, center:{x:-9,y:14}, selected:target, pins:[]});
    const restored = api.getView();
    key('c'); h.stage().clientHeight -= 64; resize();
    assert.deepEqual(api.getView(), {...restored, controlsHidden:true});
  });
});

test('map changes notify the app before native Back/Forward can leave an unsaved map entry', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:() => '#112233'});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, changes = [];
    let api;
    api = createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}, onViewChange:() => changes.push(api?.getView())});
    const before = changes.length;
    api.setIndex(fixture); api.setTarget(target);
    assert.equal(changes.length, before + 1, 'setTarget snapshots its selection and camera destination');
    h.settings.onNodeRightClick(h.data().nodes.find(node => node.file?.path === target.path), {preventDefault(){}});
    assert.equal(changes.length, before + 2, 'pinning also updates the current history entry');
    api.destroy();
  } finally { Object.assign(global, previous); }
});

test('removing session storage read/write loses hidden controls when the map is recreated in the same tab', async () => {
  await controlsHost(({api, start, key, byClass}) => {
    key('c'); api.destroy();
    assert.equal(start().getView().controlsHidden, true);
    assert.equal(byClass('map-footer').hidden, true);
  });
});

test('restoring the Pin/Unpin button or p action exposes pinning; drag and right-click still preserve pins', async () => {
  await controlsHost(({h, api, key}) => {
    const node = h.data().nodes.find(n => n.file?.root === target.root && n.file?.path === target.path);
    const noPinButton = () => assert.ok(!h.all().some(el => el.tagName === 'button' && /^(?:Pin|Unpin)\b/.test(el.textContent)));
    noPinButton(); key('p'); assert.equal(node.fx, undefined);
    h.settings.onNodeDragEnd(node); noPinButton();
    assert.equal(node.fx, node.x); assert.match(h.settings.nodeLabel(node).textContent, /pinned/);
    key('p'); assert.equal(node.fx, node.x);
    assert.equal(api.getView().pins.length, 1);
    h.settings.onNodeRightClick(node, {preventDefault(){}}); assert.equal(node.fx, undefined);
  });
});

test('restoring either zoom button or removing +/- key actions breaks keyboard-only zoom controls', async () => {
  await controlsHost(({h, key}) => {
    assert.ok(!h.all().some(el => el.tagName === 'button' && ['−', '+'].includes(el.textContent)));
    key('c'); const before = h.graph.zoom();
    key('+'); assert.equal(h.graph.zoom(), before * 1.3);
    key('-'); assert.equal(h.graph.zoom(), before);
  });
});

async function instructionColours(run) {
  await controlsHost(async ({h, api}) => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    const fill = filePath => {
      const node = h.data().nodes.find(n => n.file?.path === filePath), fills = [];
      const ctx = new Proxy({}, {get:(obj, key) => key === 'fill' ? () => fills.push(obj.fillStyle) : () => {},
        set:(obj, key, value) => { obj[key] = value; return true; }});
      assert.ok(node, filePath);
      h.settings.nodeCanvasObject(node, ctx, 1);
      return fills[0];
    };
    const theme = get => {
      global.getComputedStyle = () => ({getPropertyValue:get});
      api.setTheme();
    };
    const advance = ms => { now += ms; h.settings.onRenderFramePre(); };
    const paths = ['CLAUDE.md', 'nested/CLAUDE.md', 'AGENTS.md', 'nested/AGENTS.md', 'codex.md', '.claude/rules.md', '.codex/rules.md', 'CLAUDE.md/other.md'];
    const files = paths.map(filePath => ({...fixture.files[1], path:filePath, kind:'instruction'}));
    api.setIndex({...fixture, files, references:[]});
    try { await run({h, api, fill, theme, advance, paths}); }
    finally { Date.now = originalNow; }
  });
}

for (const [basename, token] of [['CLAUDE.md', '--orange'], ['AGENTS.md', '--red'], ['codex.md', '--orange']]) {
  test(`replacing ${basename}'s fill with another token breaks its circle colour in whole map and neighbourhood`, async () => {
    await instructionColours(({api, fill, theme, advance, paths}) => {
      theme(name => name); advance(200);
      for (const filePath of paths.filter(p => p.split('/').pop() === basename)) {
        assert.equal(fill(filePath), token);
        api.setScope({root:'alpha', path:filePath});
        assert.equal(fill(filePath), token);
        api.setScope(null);
      }
    });
  });
}

test('removing the basename/kind guard recolours ordinary instructions or changing the instruction table colour loses its dot', async () => {
  await instructionColours(({h, api, fill, theme, advance}) => {
    theme(name => name); advance(200);
    for (const filePath of ['.claude/rules.md', '.codex/rules.md', 'CLAUDE.md/other.md']) assert.equal(fill(filePath), '--orange');
    assert.equal(h.all().find(el => el.textContent === 'Agent instructions').style['--kind-colour'], 'var(--orange)');
    api.setIndex({...fixture, files:[{...fixture.files[1], path:'CLAUDE.md', kind:'doc'}], references:[]});
    assert.equal(fill('CLAUDE.md'), '--blue');
  });
});

test('removing claude or agents from animateTheme stops its fill mixing between Tokyo Night and Latte', async () => {
  const themes = ['dark', 'light'].map(name => Object.fromEntries(
    [...fs.readFileSync(path.join(__dirname, `../fixtures/serve/theme/${name}/colors.toml`), 'utf8').matchAll(/^(\w+) = "([^"]+)"/gm)]
      .map(([, key, value]) => [key, value])));
  const kindNames = ['blue', 'green', 'cyan', 'magenta', 'yellow', 'bright_blue', 'muted', 'bright_green', 'lighter_background', 'light_foreground', 'bright_magenta'];
  for (const theme of themes) {
    assert.ok(![theme.orange, ...kindNames.map(name => theme[name])].includes(theme.red));
  }
  await instructionColours(({fill, theme, advance}) => {
    const get = values => name => values[name.slice(2).replaceAll('-', '_')] || '#112233';
    theme(get(themes[0])); advance(200);
    assert.equal(fill('CLAUDE.md'), '#eb927b'); assert.equal(fill('AGENTS.md'), '#f7768e');
    theme(get(themes[1])); advance(100);
    assert.equal(fill('CLAUDE.md'), 'rgb(226,112,83)'); assert.equal(fill('AGENTS.md'), 'rgb(229,67,100)');
    advance(100);
    assert.equal(fill('CLAUDE.md'), '#d84e2b'); assert.equal(fill('AGENTS.md'), '#d20f39');
  });
});

async function filterHost(check) {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue: name => `theme:${name}`});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  let api, changes = 0;
  try {
    api = (await map).createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}, onViewChange(){ changes++; }});
    api.setIndex(structuredClone(fixture));
    const row = id => h.all().find(el => el.attributes['data-filter'] === id);
    const count = id => row(id).children.find(el => el.className === 'map-filter-count').textContent;
    await check({h, api, row, count, changes:() => changes});
  } finally { api?.destroy(); Object.assign(global, previous); }
}

test('removing the rule, type or count span makes a kind row lose its explanation', async () => {
  await filterHost(({h, row, count}) => {
    assert.equal(h.all().filter(el => el.attributes['data-filter']).length, 13);
    assert.deepEqual(row('readme').children.map(el => el.textContent),
      ['Readmes', 'README.md · .md .mmd .mermaid', '.md .mmd .mermaid', '1']);
    assert.deepEqual(row('plan').children.map(el => el.textContent), ['Plans', 'plans/ · .md .mmd .mermaid', '.md .mmd .mermaid', '0']);
    assert.deepEqual(row('diagram').children.map(el => el.textContent), ['Diagrams', 'all .mmd .mermaid files', '.mmd .mermaid', '0']);
    assert.equal(count('doc'), '3');
    assert.deepEqual(row('orphan').children.map(el => el.textContent), ['Orphans', 'no inbound reference', '', '2']);
    assert.deepEqual(row('dangling').children.map(el => el.textContent), ['Dangling', 'a reference to a missing file', '', '1']);
    assert.deepEqual(row('stale').children.map(el => el.textContent), ['Stale', 'older than the code it describes', '', '1']);
    assert.ok(!h.all().find(el => el.tagName === 'details').open);
  });
});

test('removing the index kind row build hides an added kind and its colour', async () => {
  await filterHost(({h, api, row}) => {
    const added = kind('note', 'Notes', '#123abc', ['notes/'], ['.txt']);
    const file = {...fixture.files[1], path:'notes/today.txt', kind:'note', type:'.txt'};
    api.setIndex({...fixture, kinds:[added, ...kinds], files:[...fixture.files, file]});
    assert.deepEqual(row('note').children.map(el => el.textContent), ['Notes', 'notes/ · .txt', '.txt', '1']);
    assert.equal(row('note').children[0].style['--kind-colour'], '#123abc');
    h.settings.onRenderFramePre();
    const node = h.data().nodes.find(item => item.file?.kind === 'note'), fills = [];
    const ctx = new Proxy({}, {get:(object, key) => key === 'fill' ? () => fills.push(object.fillStyle) : () => {}, set:(object, key, value) => { object[key] = value; return true; }});
    h.settings.nodeCanvasObject(node, ctx, 1);
    assert.equal(fills[0], '#123abc');
  });
});

test('reading a built-in label outside index.kinds hides a relabelled built-in', async () => {
  await filterHost(({api, row}) => {
    api.setIndex({...fixture, kinds:kinds.map(value => value.id === 'doc' ? {...value, label:'Working notes'} : value)});
    assert.equal(row('doc').children[0].textContent, 'Working notes');
  });
});

test('wrapping every kind colour directly instead of resolving its table theme name breaks the CSS variable colour', async () => {
  await filterHost(({h, row}) => {
    assert.equal(row('plan').children[0].style['--kind-colour'], 'var(--bright-blue)');
    h.settings.onRenderFramePre();
    const node = h.data().nodes.find(item => item.file?.kind === 'doc'), fills = [];
    const ctx = new Proxy({}, {get:(object, key) => key === 'fill' ? () => fills.push(object.fillStyle) : () => {}, set:(object, key, value) => { object[key] = value; return true; }});
    h.settings.nodeCanvasObject(node, ctx, 1);
    assert.equal(fills[0], 'theme:--blue');
  });
});

test('clearing selected state while rebuilding a changed kind table loses the selected file', async () => {
  await filterHost(({h, api, row}) => {
    api.setTarget(target);
    const node = h.data().nodes.find(item => item.file?.root === target.root && item.file?.path === target.path);
    h.settings.onNodeDragEnd(node); h.graph.zoom(1.75); h.graph.centerAt(30, -20);
    row('plan').click();
    const table = kinds.map(value => value.id === 'plan' ? {...value, label:'Project plans'} : value);
    api.setIndex({...fixture, kinds:table});
    assert.deepEqual(api.getView(), {controlsHidden:false, zoom:1.75, center:{x:30,y:-20}, selected:target, pins:[{...target,x:node.x,y:node.y}]});
    assert.equal(row('plan').attributes['aria-pressed'], 'false');
    assert.equal(row('plan').children[0].textContent, 'Project plans');
  });
});

test('removing kinds.delete from the row action stops toggling the drawn files and aria-pressed', async () => {
  await filterHost(({h, row}) => {
    row('doc').click();
    assert.deepEqual(h.data().nodes.filter(n => n.type === 'file').map(n => n.file.path), ['README.md']);
    assert.equal(row('doc').attributes['aria-pressed'], 'false');
    row('doc').click();
    assert.equal(row('doc').attributes['aria-pressed'], 'true');
    assert.equal(h.data().nodes.filter(n => n.type === 'file').length, 4);
    row('log').click();
    assert.equal(row('log').attributes['aria-pressed'], 'true');
    assert.ok(h.data().nodes.some(n => n.file?.path === 'logs/day.md'));
    assert.equal(h.all().find(el => el.tagName === 'summary').textContent, 'Kinds · 1 filter');
    h.all().find(el => el.textContent === 'Clear filters · 1').click();
    assert.equal(row('log').attributes['aria-pressed'], 'false');
    assert.equal(h.all().find(el => el.tagName === 'summary').textContent, 'Kinds');
  });
});

test('counting the roots filter in the Kinds summary shows a filter the list does not hold', async () => {
  await filterHost(({h, row}) => {
    const summary = () => h.all().find(el => el.tagName === 'summary').textContent;
    assert.equal(summary(), 'Kinds');
    row('orphan').click(); row('stale').click();
    assert.equal(summary(), 'Kinds · 2 filters');
    h.all().find(el => el.tagName === 'button' && el.parentNode?.attributes['aria-label'] === 'Roots' && el.textContent !== 'All roots').click();
    assert.ok(h.all().some(el => el.textContent === 'Clear filters · 3'));
    assert.equal(summary(), 'Kinds · 2 filters');
  });
});

test('zero files from active filters shows the explanation beside Clear filters', async () => {
  await filterHost(({h, row}) => {
    row('doc').click();
    row('readme').click();
    const empty = h.all().find(el => el.className === 'map-no-match');
    assert.equal(empty.hidden, false);
    assert.equal(empty.textContent, 'No files match these filters');
    h.all().find(el => el.textContent?.startsWith('Clear filters')).click();
    assert.equal(empty.hidden, true);
  });
});

test('counting model.nodes instead of data.nodes stops counts following roots, kinds, findings and refresh', async () => {
  await filterHost(({h, api, row, count}) => {
    assert.equal(count('log'), '0');
    h.all().find(el => el.textContent === 'alpha').click();
    assert.equal(count('doc'), '2'); assert.equal(count('orphan'), '1');
    row('stale').click();
    assert.equal(count('doc'), '1'); assert.equal(count('readme'), '0'); assert.equal(count('orphan'), '0');
    row('doc').click();
    assert.equal(count('doc'), '0'); assert.equal(count('stale'), '0'); assert.equal(count('dangling'), '0');
    row('doc').click(); row('stale').click();
    api.setIndex({...fixture, files:fixture.files.filter(f => f.path !== 'loose.md')});
    assert.equal(count('doc'), '1'); assert.equal(count('orphan'), '0');
    row('log').click(); assert.equal(count('log'), '1');
  });
});

test('routing Escape directly to clearSelection stops closing Kinds without selection or history changes', async () => {
  await filterHost(({h, api, row, changes}) => {
    api.setTarget(target);
    const panel = h.all().find(el => el.tagName === 'details');
    panel.open = true;
    const before = api.getView(), previousChanges = changes();
    let prevented = false, stopped = false;
    h.container.listeners.get('keydown')({key:'Escape', target:row('doc'), preventDefault(){ prevented = true; }, stopPropagation(){ stopped = true; }});
    assert.ok(stopped);
    assert.equal(panel.open, false); assert.ok(prevented);
    assert.deepEqual(api.getView(), before); assert.equal(changes(), previousChanges);
    assert.equal(h.document.activeElement.tagName, 'summary');
    panel.open = true;
    const search = h.all().find(el => el.tagName === 'input');
    search.value = 'guide';
    const escape = {key:'Escape', preventDefault(){}, stopPropagation(){ stopped = true; }};
    search.onkeydown(escape);
    assert.equal(search.value, ''); assert.equal(panel.open, true);
    stopped = false; search.onkeydown(escape);
    assert.equal(panel.open, false); assert.ok(stopped);
    assert.deepEqual(api.getView(), before); assert.equal(changes(), previousChanges);
  });
});
