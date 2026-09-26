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
  const m = await model(), {targetOf, pointSide, describe} = await map, data = m.view();
  const ghosts = data.nodes.filter(n => n.type === 'ghost');
  assert.equal(new Set(ghosts.map(n => n.id)).size, 2);
  const anchor = data.nodes.find(n => n.type === 'anchor');
  assert.match(describe(anchor), /source, not a document/);
  for (const node of [...ghosts, anchor]) { assert.equal(targetOf(node), null); assert.equal(node.file, undefined); }
  assert.equal(pointSide(anchor), 5, 'an anchor has no inbound-derived size');
  assert.equal(data.links.filter(l => l.style === 'impact').length, 1);
  assert.deepEqual(ghosts.map(n => n.label), ['missing.md · missing', 'missing.md · missing'], 'the target path, not the raw Markdown');
  assert.match(describe(ghosts[0]), /· markdown · line \d · missing: missing\.md$/);
  const {missingTarget} = await map;
  assert.equal(missingTarget({style:'markdown', text:'[see [1]](docs/a[1].md#part)'}), 'docs/a[1].md#part');
  assert.equal(missingTarget({style:'wikilink', text:'[[Plan|the plan]]'}), 'Plan');
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

test('inbound point size is logarithmic/clamped, pins toggle, edge styles and theme kind tokens remain distinct', async () => {
  const {pointSide, togglePin, edgeDash, palette} = await map;
  const n = {type:'file', file:{inbound:0}, x:12, y:24}; assert.equal(pointSide(n), 2.5);
  n.file.inbound = 1; assert.equal(pointSide(n), 4); n.file.inbound = 1000000; assert.equal(pointSide(n), 9);
  n.file.inbound = 0; assert.ok(pointSide(n, 1) >= 9, 'fully zoomed in, even an unreferenced point holds a glyph');
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

test('a scoped visit restarts layout and the probe cools after its engine stops', async () => {
  await filterHost(({h, api}) => {
    h.settings.onEngineStop();
    assert.equal(api.probe().cooled, true);
    api.setVisible(false);
    api.setVisible(true);
    api.setScope(target);
    assert.deepEqual(api.probe().scope, target);
    assert.equal(api.probe().cooled, false, 'the previous whole-map stop does not stand for scoped layout');
    assert.ok(h.calls.includes('d3ReheatSimulation'), 'scoped graph starts its engine');
    h.settings.onEngineTick();
    h.settings.onEngineStop();
    assert.equal(api.probe().cooled, true);
  });
});

test('changing the 12 multiplier makes the 45-file cluster ring less than three times the old 35', async () => {
  const {clusterRadius} = await map;
  assert.ok(clusterRadius(45) >= 35 * 3);
});

test('removing the fixed 50 offset puts an orphan on the ordinary cluster ring', async () => {
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

// A canvas context that keeps assigned properties and records calls and assignments.
function recorder() {
  const calls = [], state = {fillStyle:'#112233'};
  return new Proxy(state, {
    get:(object, key) => key === 'calls' ? calls : key in object ? object[key] : (...args) => {
      calls.push([key, ...args]);
      return key === 'createRadialGradient' ? {stops:[], addColorStop(...stop) { this.stops.push(stop); }} : calls.length;
    },
    set:(object, key, value) => { object[key] = value; calls.push(['set', key, value]); return true; }
  });
}

// A small host/engine boundary harness: tests Markdown Atlas callbacks and lifecycle,
// not browser canvas rendering or force-graph's own layout implementation.
function host() {
  const listeners = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {setProperty(k, v){ this[k] = v; }}; this.classList = {add(){}, remove(){}}; this.value = ''; this.clientWidth = 800; this.clientHeight = 600; }
    addEventListener(key, handler, options) { this.listeners ??= new Map(); this.listeners.set(key, handler); this.listenerOptions ??= new Map(); this.listenerOptions.set(key, options); }
    removeEventListener(key) { this.listeners.delete(key); }
    append(el) { el.parentNode = this; this.children.push(el); }
    replaceChildren() { this.children = []; }
    querySelector() { return null; }
    setAttribute(k, v) { this.attributes[k] = v; }
    focus() { document.activeElement = this; }
    closest(selector) { return selector.split(', ').some(part => part === this.tagName) ? this : null; }
    click() { if (!this.disabled) this.onclick?.({}); }
    getContext() { return this.context ??= recorder(); }
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
    if (key === 'getGraphBbox') return () => {
      const xs = graphData.nodes.map(n => n.x), ys = graphData.nodes.map(n => n.y);
      return xs.length ? {x:[Math.min(...xs) - 4, Math.max(...xs) + 4], y:[Math.min(...ys) - 4, Math.max(...ys) + 4]} : null;
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

test('changing charge -140, distanceMax 320 or link distance 70, or dropping the aspect force, leaves the fake graph with old force settings', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:() => '#112233'});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, api = createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    assert.deepEqual(h.forceSettings.get('charge'), {strength:-140, distanceMax:320});
    assert.deepEqual(h.forceSettings.get('link'), {distance:70});
    assert.equal(typeof h.forces.get('aspect'), 'function');
    assert.equal(h.settings.autoPauseRedraw, true, 'the graph canvas redraws only when something changed');
    api.destroy();
  } finally { Object.assign(global, previous); }
});

test('the initial fit leaves 6% of the short side, at least 48 px, around the files and 24 px more at the top', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:() => '#112233'});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const {createMap} = await map, api = createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    h.stage().clientWidth = 300;
    api.setIndex(fixture); api.setScope(target); h.settings.onEngineStop(); h.completeCentre();
    assert.equal(h.data().nodes.length, 7);
    // Seven nodes at x 0..120, y 0..60 with force-graph's 4-unit node margin;
    // a 300 px canvas keeps the 48 px floor: (300 - 96) / 128 across.
    assert.equal(h.graph.zoom(), 1.59375);
    assert.deepEqual(h.graph.centerAt(), {x:60, y:30 - 12 / 1.59375});
    // 6% of a 1,000 px short side is 60 px: (1600 - 120) / 1208.
    h.stage().clientWidth = 1600; h.stage().clientHeight = 1000;
    h.data().nodes.forEach((node, i) => { node.x = i * 200; node.y = i * 100; });
    h.listeners.get('keydown')({key:'f', target:h.container, preventDefault(){}}); h.completeCentre();
    assert.equal(h.graph.zoom(), 1480 / 1208);
    // A tall box is bound by the height less the 24 px for the root label.
    h.data().nodes.forEach((node, i) => { node.x = 0; node.y = i * 200; });
    h.listeners.get('keydown')({key:'f', target:h.container, preventDefault(){}}); h.completeCentre();
    assert.equal(h.graph.zoom(), (1000 - 120 - 24) / 1208);
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
    // Hover lights the hovered file's references; with no hover the selected file's stay lit.
    const betaGuide = h.data().nodes.find(n => n.file?.root === 'beta'), edge = () => h.settings.linkColor(h.data().links[0]);
    h.settings.onNodeHover(betaGuide); assert.equal(edge(), 'dark:--foreground');
    h.settings.onNodeHover(node); assert.equal(edge(), 'dark:--accent');
    h.settings.onNodeHover(null); assert.equal(edge(), 'dark:--accent');
    // Zoomed in, the point becomes a tile with a glyph; zoomed out it is a bare
    // square. The stale tick and selection brackets coexist, no recency ring on
    // an old file, and the pointer region surrounds the visible node.
    const drawing = [], ctx = new Proxy({}, {get:(_, name) => (...args) => drawing.push([name,...args]), set:() => true});
    h.settings.nodeCanvasObject(node, ctx, 3);
    assert.ok(drawing.some(call => call[0] === 'translate'));
    drawing.length = 0; h.settings.nodeCanvasObject(node, ctx, .1);
    assert.ok(!drawing.some(call => call[0] === 'translate'));
    assert.equal(drawing.filter(call => call[0] === 'fillRect').length, 2);
    assert.equal(drawing.filter(call => call[0] === 'lineTo').length, 8);
    assert.equal(drawing.filter(call => call[0] === 'arc').length, 0);
    // The hit region is the drawn square plus 3 px, never under 6 px.
    for (const scale of [1, 3]) {
      drawing.length = 0; h.settings.nodeCanvasObject(node, ctx, scale);
      const side = drawing.find(call => call[0] === 'fillRect')[3];
      drawing.length = 0; h.settings.nodePointerAreaPaint(node, '#123456', ctx, scale);
      const hit = drawing.find(call => call[0] === 'arc')[3];
      assert.ok(Math.abs(hit - Math.max(side / 2 + 3 / scale, 6 / scale)) < 1e-9, `scale ${scale}`);
      assert.ok(hit < (scale === 1 ? 7 : 5), 'no longer the old glyph circle');
    }
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
    // The impact source's label, drawn always, would cover the beta file's.
    h.data().nodes.find(n => n.type === 'anchor').x = -1000;
    const other = h.data().nodes.find(n => n.file?.root === 'beta'); drawing.length = 0; h.settings.nodeCanvasObject(other, ctx, .1);
    assert.ok(!drawing.some(call => call[0] === 'fillText')); key('v'); drawing.length = 0; h.settings.nodeCanvasObject(other, ctx, .1);
    assert.ok(drawing.some(call => call[0] === 'fillText'));
    key('Escape'); key('j'); assert.deepEqual(events.pop(), ['select',{root:'alpha',path:'README.md'}]); api.setTarget(target);
    h.settings.onNodeRightClick(node, {preventDefault(){}}); assert.equal(node.fx, node.x);
    h.graph.zoom(2); const coordinates = [node.x,node.y,node.fx,node.fy]; const graphUpdates = h.calls.filter(c => c === 'graphData').length;
    const fieldFills = () => {
      const calls = h.all().find(e => e.className === 'map-field').context.calls, start = calls.findLastIndex(c => c[0] === 'clearRect');
      return calls.slice(start).filter(c => c[0] === 'set' && c[1] === 'fillStyle').map(c => c[2]);
    };
    assert.ok(fieldFills().includes('dark:--foreground'));
    theme = 'light'; api.setTheme();
    assert.ok(fieldFills().includes('light:--foreground') && !fieldFills().includes('dark:--foreground'), 'the field repaints in the new text colour');
    assert.equal(h.settings.autoPauseRedraw, false, 'the graph redraws every frame during the theme blend');
    const blendStart = Date.now, started = Date.now(); Date.now = () => started + 250;
    try { h.settings.onRenderFramePre({}, 2); } finally { Date.now = blendStart; }
    assert.equal(h.settings.autoPauseRedraw, true, 'and only for 250 ms');
    assert.equal(h.settings.backgroundColor, undefined, 'an opaque graph background would hide the field');
    assert.equal(h.graph.zoom(), 2);
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
    assert.equal(shown(byClass('map-controls')), false, 'the filter row hides too');
    assert.deepEqual(h.all(byClass('map-canvas')).filter(el => el.tagName === 'button' && shown(el)), [toggle]);
    assert.equal(toggle.textContent, 'Show controls c');
    assert.equal(h.document.activeElement, byClass('map-stage'));
    key('Enter'); key('e'); assert.deepEqual(events, [['read',target], ['edit',target]]);
    const unfitted = h.graph.zoom(); key('f'); assert.notEqual(h.graph.zoom(), unfitted);
    toggle.click();
    for (const name of ['map-controls', 'map-search', 'map-graph-controls', 'map-footer']) assert.equal(shown(byClass(name)), true);
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
      const ctx = new Proxy({}, {get:(obj, key) => key === 'fillRect' ? () => fills.push(obj.fillStyle) : () => {},
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
  test(`replacing ${basename}'s fill with another token breaks its point colour in whole map and neighbourhood`, async () => {
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
    // The point is the text colour tinted 60% toward orange or red.
    assert.equal(fill('CLAUDE.md'), 'rgb(209,158,159)'); assert.equal(fill('AGENTS.md'), 'rgb(216,142,171)');
    theme(get(themes[1])); advance(100);
    assert.equal(fill('CLAUDE.md'), 'rgb(185,118,114)'); assert.equal(fill('AGENTS.md'), 'rgb(187,91,124)');
    advance(100);
    assert.equal(fill('CLAUDE.md'), 'rgb(160,78,68)'); assert.equal(fill('AGENTS.md'), 'rgb(156,41,76)');
  });
});

async function filterHost(check) {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  // The Recent count resolves the CSS text token; canvas text reads it there.
  global.getComputedStyle = el => ({getPropertyValue: name => `theme:${name}`, color: el.className === 'map-filter-count' ? 'theme:text-soft' : undefined});
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
    assert.equal(h.all().filter(el => el.attributes['data-filter']).length, 14);
    assert.deepEqual(row('readme').children.map(el => el.textContent), ['Readmes', 'README.md', '.md, .mmd, .mermaid', '1']);
    assert.deepEqual(row('plan').children.map(el => el.textContent), ['Plans', 'plans/', '.md, .mmd, .mermaid', '0']);
    assert.deepEqual(row('diagram').children.map(el => el.textContent), ['Diagrams', 'Any path', '.mmd, .mermaid', '0']);
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
    assert.deepEqual(row('note').children.map(el => el.textContent), ['Notes', 'notes/', '.txt', '1']);
    assert.equal(row('note').children[0].style['--kind-colour'], '#123abc');
    h.settings.onRenderFramePre();
    const node = h.data().nodes.find(item => item.file?.kind === 'note'), fills = [];
    const ctx = new Proxy({}, {get:(object, key) => key === 'fillRect' ? () => fills.push(object.fillStyle) : () => {}, set:(object, key, value) => { object[key] = value; return true; }});
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
    const ctx = new Proxy({}, {get:(object, key) => key === 'fillRect' ? () => fills.push(object.fillStyle) : () => {}, set:(object, key, value) => { object[key] = value; return true; }});
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

test('recency follows the contract on the client clock: open or within 30 min red, within 24 h orange, older none', async () => {
  const {recency, describe} = await map, now = Date.parse('2026-09-25T12:00:00Z');
  const at = age => ({root:'alpha', path:'a.md', kind:'doc', modified:new Date(now - age).toISOString(), open:false});
  // 2 is the red highlight, 1 the orange one, 0 none.
  assert.equal(recency(at(0), now), 2);
  assert.equal(recency(at(30 * 60e3), now), 2);
  assert.equal(recency(at(30 * 60e3 + 1), now), 1);
  assert.equal(recency(at(24 * 3600e3), now), 1);
  assert.equal(recency(at(24 * 3600e3 + 1), now), 0);
  assert.equal(recency({...at(30 * 86400e3), open:true}, now), 2);
  assert.equal(recency({open:false}, now), 0, 'an index without modified has no highlight');
  assert.match(describe({type:'file', file:{...at(30 * 86400e3), open:true}}, now), / · open in editor$/);
  assert.match(describe({type:'file', file:at(60e3)}, now), / · edited within 30 min$/);
  assert.match(describe({type:'file', file:at(3600e3)}, now), / · edited within 24 h$/);
  const original = Date.now;
  Date.now = () => now;
  try { assert.equal(recency(at(31 * 60e3)), 1, 'the default clock is Date.now'); }
  finally { Date.now = original; }
});

const recentNow = Date.parse('2026-09-25T12:00:00Z');
function recentIndex() {
  const index = structuredClone(fixture);
  index.files[0].modified = '2026-09-25T11:45:00Z'; // alpha/README.md: red by time
  index.files[1].modified = '2026-09-24T13:00:00Z'; // alpha/guide.md: orange
  index.files[2].open = true;                       // alpha/loose.md: open, so red however old
  return index;
}
async function atRecentNow(run) {
  const original = Date.now;
  let now = recentNow;
  Date.now = () => now;
  try { await run(ms => { now = recentNow + ms; }); } finally { Date.now = original; }
}

// The status line's text across its spans.
const text = el => el.children.length ? el.children.map(text).join('') : el.textContent;

test('Recent sits beside Kinds, keeps open and 24 h files, counts them in the status line and clears with the filters', async () => {
  await atRecentNow(async () => {
    const m = (await map).createModel(); m.setIndex(recentIndex()); m.filters.recent = true;
    assert.deepEqual(m.view().nodes.filter(n => n.type === 'file').map(n => n.file.path), ['README.md', 'guide.md', 'loose.md']);
    assert.deepEqual(m.view(null, recentNow + 86400e3).nodes.filter(n => n.type === 'file').map(n => n.file.path), ['loose.md']);
    await filterHost(({h, api, row, count}) => {
      api.setIndex(recentIndex());
      const status = h.all().find(el => el.className === 'map-status'), recent = row('recent');
      const siblings = recent.parentNode.children;
      assert.equal(siblings[siblings.indexOf(recent) + 1].tagName, 'details', 'Recent is the control beside Kinds');
      assert.equal(text(status), 'Markdown Atlas · 4 files · 5 refs · 2 in 30 min · 1 in 24 h');
      assert.equal(status.title, 'Markdown Atlas · 4 files · 5 refs · 2 open in editor or edited within 30 min · 1 edited within 24 h');
      assert.equal(status.attributes['aria-label'], status.title);
      assert.deepEqual(status.children.filter(el => el.className).map(el => [el.className, el.textContent]), [['map-now', '2'], ['map-today', '1']], 'the numbers carry the ring colours');
      assert.equal(count('recent'), '3');
      recent.click();
      assert.equal(recent.attributes['aria-pressed'], 'true');
      assert.deepEqual(h.data().nodes.filter(n => n.type === 'file').map(n => n.file.path), ['README.md', 'guide.md', 'loose.md']);
      assert.equal(h.all().find(el => el.tagName === 'summary').textContent, 'Kinds');
      h.all().find(el => el.textContent === 'Clear filters · 1').click();
      assert.equal(recent.attributes['aria-pressed'], 'false');
      assert.equal(h.data().nodes.filter(n => n.type === 'file').length, 4);
      recent.click(); api.setTarget({root:'beta', path:'guide.md'});
      h.all().find(e => e.textContent === 'Reveal target').click();
      assert.equal(recent.attributes['aria-pressed'], 'false', 'revealing an old file lifts Recent');
      api.setScope(target);
      assert.equal(text(status), 'Neighbourhood · 4 files · 6 refs · 2 in 30 min · 1 in 24 h');
    });
  });
});

function drawCalls(h, node) {
  const calls = [];
  const ctx = new Proxy({}, {get:(_, name) => (...args) => calls.push([name, ...args.map(v => typeof v === 'number' ? +v.toFixed(6) : v)]),
    set:(_, key, value) => { calls.push(['set', key, typeof value === 'number' ? +value.toFixed(6) : value]); return true; }});
  h.settings.onRenderFramePre(ctx, 1); h.settings.nodeCanvasObject(node, ctx, 1);
  return calls;
}
const coreFill = calls => { const at = calls.findIndex(c => c[0] === 'fillRect'); return calls.slice(0, at).filter(c => c[0] === 'set' && c[1] === 'fillStyle').at(-1)[2]; };
// Rings in one field paint, centred on (x, y) in device pixels: each sprite
// stamped there, read back from the stroke it holds, at the alpha it was stamped.
function rings(calls, x, y) {
  const state = {}, found = [];
  for (const call of calls) {
    if (call[0] === 'set') state[call[1]] = call[2];
    else if (call[0] === 'drawImage' && call[2] + call[1].width / 2 === Math.round(x) && call[3] + call[1].height / 2 === Math.round(y)) {
      const stroke = call[1].getContext('2d').calls, set = key => stroke.findLast(c => c[0] === 'set' && c[1] === key)[2];
      found.push({style:set('strokeStyle'), width:set('lineWidth'), alpha:+state.globalAlpha.toFixed(6), radius:stroke.find(c => c[0] === 'arc')[3]});
    }
  }
  return found;
}
// A canvas for sprites that records what is stroked into it.
const spriteCanvas = () => ({getContext() { return this.context ??= recorder(); }});
// Each fillRect in one field paint with the alpha it was drawn at.
function points(calls) {
  const state = {}, found = [];
  for (const call of calls) {
    if (call[0] === 'set') state[call[1]] = call[2];
    else if (call[0] === 'fillRect') found.push({x:call[1], y:call[2], size:call[3], alpha:state.globalAlpha, fill:state.fillStyle});
  }
  return found;
}

function motionHost(reduce) {
  const h = host(), frames = [], cancelled = [], timers = [];
  let query;
  h.document.defaultView = {devicePixelRatio:1,
    matchMedia:text => (query = {text, matches:reduce, addEventListener(_, handler) { query.handler = handler; }, removeEventListener() { query.handler = null; }}),
    requestAnimationFrame:callback => frames.push(callback), cancelAnimationFrame:id => cancelled.push(id),
    setTimeout:callback => timers.push(callback), clearTimeout() {}};
  // Runs the timers due so far; any they set wait for the next call.
  const runTimers = () => timers.splice(0).forEach(callback => callback());
  return {h, frames, cancelled, runTimers, query:() => query};
}
async function withMotion(reduce, run) {
  const previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  const setup = motionHost(reduce);
  global.ForceGraph = () => () => setup.h.graph;
  global.getComputedStyle = () => ({getPropertyValue:name => `theme:${name}`});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  let api;
  try {
    api = (await map).createMap(setup.h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    const field = setup.h.all().find(el => el.className === 'map-field').context;
    const paints = () => {
      const starts = field.calls.flatMap((c, i) => c[0] === 'clearRect' ? [i] : []);
      return starts.map((start, i) => field.calls.slice(start, starts[i + 1]));
    };
    // The field canvas is 800 × 600 with the camera at the origin, zoom 1.
    const screen = node => [node.x + 400, node.y + 300];
    await run({...setup, api, paints, screen});
  } finally { api?.destroy(); Object.assign(global, previous); }
}

test('red breathes over two seconds as a glow band and a crisp ring, orange holds one thin ring, and neither replaces the kind tint', async () => {
  await atRecentNow(async advance => {
    await withMotion(false, ({h, api, frames, paints, screen}) => {
      api.setIndex(recentIndex());
      let clock = 0;
      const paint = () => { frames.at(-1)(clock += 40); return paints().at(-1); };
      const node = path => h.data().nodes.find(n => n.root === 'alpha' && n.file?.path === path);
      const ringsOf = path => rings(paint(), ...screen(node(path)));
      advance(10000); const red = ringsOf('README.md');
      assert.deepEqual(red.map(r => [r.style, r.width]), [['theme:--red', 6], ['theme:--red', 1]], 'a glow band and a crisp ring');
      advance(11000); assert.notDeepEqual(ringsOf('README.md'), red, 'the halo moves within its period');
      advance(12000); assert.deepEqual(ringsOf('README.md'), red, 'the halo repeats every two seconds');
      assert.equal(ringsOf('loose.md').length, 2, 'an open file is red however old');
      const orange = ringsOf('guide.md');
      assert.deepEqual(orange.map(r => [r.style, r.width, r.alpha]), [['theme:--orange', 1, .8]]);
      advance(11000); assert.deepEqual(ringsOf('guide.md'), orange, 'the orange ring is steady');
      assert.equal(coreFill(drawCalls(h, node('guide.md'))), 'theme:--blue'); assert.equal(coreFill(drawCalls(h, node('loose.md'))), 'theme:--blue');
      assert.ok(!drawCalls(h, node('README.md')).some(c => c[0] === 'arc'), 'the rings live on the field, not the graph canvas');
      advance(2 * 86400e3);
      assert.equal(ringsOf('guide.md').length, 0, 'a day later the ring is gone without a reindex');
    });
  });
});

// Every test awaits the module before it draws a frame.
let loaded; map.then(module => { loaded = module; });
const frameOf = values => ({k:1, cx:0, cy:0, width:800, height:600, ratio:1, t:0, now:recentNow, breath:.5, light:false, hovering:false,
  lit:{nodes:new Set(), links:new Set()}, nodes:[], colours:{foreground:'fg', accent:'ac', red:'rd', orange:'or'}, rings:loaded.ringSprites(spriteCanvas), ...values});

test('the field draws red to 30 min and while open, orange to 24 h, nothing after; the two differ in form', async () => {
  const {drawFilament, createFilament} = await map, empty = createFilament([], [], 0);
  const at = (age, open = false) => ({id:'n', type:'file', x:0, y:0, modified:recentNow - age, file:{inbound:0, orphan:false, open}});
  const form = node => { const ctx = recorder(); drawFilament(ctx, empty, frameOf({nodes:[node]})); return rings(ctx.calls, 400, 300).map(r => [r.style, r.width]); };
  const red = [['rd', 6], ['rd', 1]], orange = [['or', 1]];
  assert.deepEqual(form(at(0)), red);
  assert.deepEqual(form(at(30 * 60e3)), red);
  assert.deepEqual(form(at(30 * 60e3 + 1)), orange);
  assert.deepEqual(form(at(24 * 3600e3)), orange);
  assert.deepEqual(form(at(24 * 3600e3 + 1)), []);
  assert.deepEqual(form(at(30 * 86400e3, true)), red);
  // In a light theme the crisp ring thickens and the glow softens.
  const ctx = recorder(); drawFilament(ctx, empty, frameOf({nodes:[at(0)], light:true}));
  assert.deepEqual(rings(ctx.calls, 400, 300).map(r => [r.width, r.alpha]), [[6, +(.19 * .6).toFixed(6)], [1.5, .8]]);
});

test('every field point is drawn at whole device pixels and dust is one device pixel', async () => {
  const {drawFilament, createFilament, sizeStreams} = await map, m = await model(), data = m.view();
  data.nodes.forEach((node, i) => { node.x = i * 13.37; node.y = i * 7.77 - 20; });
  for (const link of data.links) { link.source = m.byID(link.source); link.target = m.byID(link.target); }
  const filament = createFilament(data.nodes, data.links, data.fileCount); sizeStreams(filament, 1.3);
  for (const light of [false, true]) {
    const ctx = recorder(); drawFilament(ctx, filament, frameOf({ratio:2, k:1.3, cx:3.3, cy:-2.1, t:1.234, nodes:data.nodes, light}));
    const drawn = points(ctx.calls);
    assert.ok(drawn.length > 300);
    assert.ok(drawn.every(p => Number.isInteger(p.x) && Number.isInteger(p.y)), 'removing the snap smears points across device pixels');
    assert.ok(drawn.filter(p => p.size === 1).length > 200, 'dust is one device pixel at ratio 2');
    assert.ok(drawn.every(p => [1, 2, 3.2].includes(p.size)), 'points are 1 and 1.6 CSS pixels');
  }
});

test('no resting particle is drawn above the dimmest node, in dark or light themes', async () => {
  const {drawFilament, createFilament, sizeStreams} = await map, m = await model(), data = m.view();
  data.nodes.forEach((node, i) => { node.x = i * 20; node.y = i * 10; });
  for (const link of data.links) { link.source = m.byID(link.source); link.target = m.byID(link.target); }
  const filament = createFilament(data.nodes, data.links, data.fileCount); sizeStreams(filament, 1);
  const drawn = light => { const ctx = recorder(); drawFilament(ctx, filament, frameOf({nodes:data.nodes, light, t:3})); return points(ctx.calls); };
  const brightest = light => Math.max(...drawn(light).map(p => p.alpha));
  const orphanAlpha = async background => {
    let alpha;
    const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
    global.ForceGraph = () => () => h.graph;
    global.getComputedStyle = () => ({getPropertyValue:name => name === '--background' ? background : '#7f7f7f'});
    global.ResizeObserver = class { observe() {} disconnect() {} };
    try {
      const api = (await map).createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
      api.setIndex(fixture);
      const orphan = h.data().nodes.find(n => n.file?.orphan), ctx = recorder();
      const real = Date.now, later = real() + 1000; Date.now = () => later;
      try { h.settings.onRenderFramePre(recorder(), 1); h.settings.nodeCanvasObject(orphan, ctx, 1); } finally { Date.now = real; }
      alpha = points(ctx.calls)[0].alpha;
      api.destroy();
    } finally { Object.assign(global, previous); }
    return alpha;
  };
  assert.ok(brightest(false) > .4 && brightest(false) <= .48); assert.equal(await orphanAlpha('#1a1b26'), .5);
  assert.ok(brightest(true) > .56 && brightest(true) <= .48 * 1.4 + 1e-9); assert.equal(await orphanAlpha('#eff1f5'), .7);
  assert.ok(drawn(true).some(p => p.fill === 'fg' && p.alpha > .56), 'the bright tier includes foreground points in light themes');
});

test('the particle budget: nebulae by inbound rank, streams by screen length, at most 3,600 points', async () => {
  const {createFilament, sizeStreams, drawFilament, DUST} = await map;
  const files = (count, inbound) => Array.from({length:count}, (_, i) => ({id:`f${String(i).padStart(4, '0')}`, type:'file', x:i % 40, y:Math.floor(i / 40), file:{inbound:inbound(i), orphan:inbound(i) === 0}}));
  const sizes = f => f.owners.map((_, o) => f.owner.filter(v => v === o).length);
  const chain = nodes => nodes.slice(1).map((node, i) => ({source:nodes[i], target:node, style:'markdown', reference:{line:1}}));
  // 8 + 18·log2(1 + inbound): 62 for 7 inbound, 26 for 1, capped at 90; an
  // orphan 3, a ghost none; a tree this small grows each nebula 3 times.
  const small = createFilament([...files(3, i => [7, 1, 0][i]), {id:'hub', type:'file', file:{inbound:1000, orphan:false}}, {id:'ghost', type:'ghost'}], [], 4);
  assert.deepEqual(sizes(small), [270, 186, 78, 9]);
  assert.deepEqual(small.owners.map(n => n.id), ['hub', 'f0000', 'f0001', 'f0002']);
  // Above 600 files each nebula is halved, and the lowest ranks go without once
  // 3,000 less the streams' 1,200 is spent.
  const mid = files(700, i => i % 50), midF = createFilament(mid, chain(mid), 700);
  assert.equal(midF.streamBudget, 1200); assert.equal(midF.count, 1800);
  assert.equal(sizes(midF)[0], 45);
  const lowest = Math.min(...midF.owners.map(n => n.file.inbound));
  assert.ok(mid.filter(n => !midF.owners.includes(n)).every(n => n.file.inbound <= lowest), 'handed out by inbound rank');
  // Above 1,200 files there are no streams and the nebulae take all 3,000.
  const big = files(1300, i => i % 50), bigF = createFilament(big, chain(big), 1300);
  assert.equal(bigF.links.length, 0); assert.equal(bigF.count, 3000);
  // A stream point per 6 screen px, 6 to 24 per reference, half for path and wikilink.
  const origin = {x:0, y:0}, link = (length, style) => ({source:origin, target:{x:length, y:0}, style, reference:{line:1}});
  const streams = createFilament([], ['markdown', 'markdown', 'markdown', 'path', 'wikilink', 'impact'].map((style, i) => link([100, 10, 1000, 100, 100, 100][i], style)), 0);
  sizeStreams(streams, 1); assert.deepEqual([...streams.streamCount], [17, 6, 24, 8, 8, 17]);
  sizeStreams(streams, 2); assert.deepEqual([...streams.streamCount], [24, 6, 24, 12, 12, 24]);
  sizeStreams(midF, 50); assert.ok(midF.streamCount.reduce((a, b) => a + b, 0) <= 1200, 'streams scale down into their budget');
  for (const [f, nodes] of [[midF, mid], [bigF, big]]) {
    assert.ok(f.count + f.streamBudget + DUST <= 3600);
    const ctx = recorder(); drawFilament(ctx, f, frameOf({width:4000, height:4000, cx:20, cy:15, k:50, nodes}));
    assert.ok(points(ctx.calls).length <= 3600);
  }
});

test('default-zoom labels: the top eighth of files by inbound (3 to 8), every red file, no overlaps', async () => {
  const {chooseLabels} = await map;
  const file = (id, inbound, y) => ({id, type:'file', name:`${id}.md`, x:0, y, modified:recentNow - 9 * 86400e3, file:{inbound, open:false}});
  const names = (nodes, scale = 1) => [...chooseLabels(nodes, scale, recentNow)].sort();
  const nodes = Array.from({length:16}, (_, i) => file(`f${String(i).padStart(2, '0')}`, i, i * 100));
  assert.deepEqual(names(nodes), ['f13', 'f14', 'f15'], 'round(16 / 8) rises to the floor of 3');
  assert.equal(names(Array.from({length:80}, (_, i) => file(`g${String(i).padStart(2, '0')}`, i, i * 100))).length, 8, 'round(80 / 8) caps at 8');
  nodes[0].modified = recentNow - 60e3;
  assert.deepEqual(names(nodes), ['f00', 'f13', 'f14', 'f15'], 'a red file is labelled whatever its rank');
  nodes[14].y = nodes[15].y + 5;
  assert.deepEqual(names(nodes), ['f00', 'f13', 'f15'], 'a name that would overlap one placed is dropped');
  assert.deepEqual(names(nodes, 3), ['f00', 'f13', 'f14', 'f15'], 'zoomed in, the two separate');
  const every = [...chooseLabels(nodes, 1, recentNow, true)];
  assert.equal(every.length, 15); assert.ok(!every.includes('f14'), 'with every file a candidate, an overlapping label is still dropped');
  await filterHost(({h}) => {
    // Away from the impact source, whose label is drawn always.
    h.data().nodes.find(n => n.type === 'anchor').x = -1000;
    for (let i = 0; i < 2; i++) h.listeners.get('keydown')({key:'v', target:h.container, preventDefault(){}});
    const guide = h.data().nodes.find(n => n.root === 'alpha' && n.file?.path === 'guide.md');
    const beta = h.data().nodes.find(n => n.root === 'beta');
    const label = node => { const real = Date.now, later = real() + 1000; Date.now = () => later; let calls; try { calls = drawCalls(h, node); } finally { Date.now = real; } const at = calls.findIndex(c => c[0] === 'fillText'); return at < 0 ? null : [calls[at][1], ...['font', 'fillStyle', 'globalAlpha'].map(key => calls.slice(0, at).filter(c => c[0] === 'set' && c[1] === key).at(-1)[2])]; };
    assert.deepEqual(label(guide), ['guide.md', '500 10px theme:--font-monospace', 'theme:text-soft', 1], 'the basename at default zoom, in the text colour');
    const calls = drawCalls(h, guide), point = calls.find(c => c[0] === 'fillRect'), text = calls.find(c => c[0] === 'fillText');
    assert.ok(text[2] - guide.x >= point[3] / 2 + 4, 'the label clears its own point');
    assert.equal(label(beta), null, 'an unranked orphan has no label');
    h.listeners.get('keydown')({key:'v', target:h.container, preventDefault(){}});
    assert.equal(label(beta)[0], 'guide.md · orphan', 'v labels every file that fits, with its full label');
  });
  // Recent showing 12 or fewer files labels all of them, not the top 3.
  await atRecentNow(() => filterHost(({h, api, row}) => {
    const files = Array.from({length:20}, (_, i) => ({...fixture.files[1], path:`f${String(i).padStart(2, '0')}.md`, stale:false,
      modified:i < 7 ? '2026-09-25T02:00:00Z' : '2026-09-01T00:00:00Z'}));
    api.setIndex({...fixture, files, references:[]});
    const place = () => { h.data().nodes.forEach((node, i) => { node.x = 0; node.y = i * 40; }); h.settings.onEngineStop(); };
    const labelled = () => h.data().nodes.filter(node => drawCalls(h, node).some(c => c[0] === 'fillText')).length;
    place(); assert.equal(labelled(), 3);
    row('recent').click(); place();
    assert.equal(h.data().nodes.length, 7); assert.equal(labelled(), 7);
  }));
});

test('the aspect force stretches the layout to the canvas and leaves positions finite for any ratio', async () => {
  const {aspectForce} = await map;
  for (const ratio of [2, .5, 1, 0, NaN, Infinity, 1e9]) {
    const nodes = Array.from({length:24}, (_, i) => ({x:Math.cos(i) * 100, y:Math.sin(i) * 100, vx:0, vy:0}));
    const force = aspectForce(() => ratio); force.initialize(nodes);
    for (let tick = 0; tick < 300; tick++) { force(.5); for (const node of nodes) { node.x += node.vx *= .6; node.y += node.vy *= .6; } }
    assert.ok(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), `ratio ${ratio}`);
    const span = key => Math.max(...nodes.map(n => n[key])) - Math.min(...nodes.map(n => n[key]));
    if (ratio > 1 && Number.isFinite(ratio)) assert.ok(span('y') < span('x') / 2, `ratio ${ratio} flattens`);
    else if (ratio > 0 && ratio < 1) assert.ok(span('x') < span('y') / 2, `ratio ${ratio} narrows`);
    else assert.ok(Math.abs(span('x') - span('y')) < 1, `ratio ${ratio} (a hidden canvas) leaves the layout alone`);
  }
});

test('reduced motion paints one still frame at t = 0, runs no loop and repaints on camera, theme and hover', async () => {
  await atRecentNow(async advance => {
    await withMotion(true, ({h, api, frames, paints, query, screen}) => {
      assert.equal(query().text, '(prefers-reduced-motion: reduce)');
      api.setIndex(recentIndex());
      assert.equal(frames.length, 0, 'no animation frame is ever requested');
      const rects = paint => paint.filter(c => c[0] === 'fillRect'), first = paints().at(-1), count = paints().length;
      assert.ok(rects(first).length > 300);
      const graphFrame = scale => { h.settings.onRenderFramePre(recorder(), scale); h.settings.onRenderFramePost(recorder(), scale); };
      advance(10000); graphFrame(1);
      assert.equal(paints().length, count, 'a graph frame with the camera still leaves the field alone');
      h.graph.zoom(2); graphFrame(2);
      assert.equal(paints().length, count + 1, 'a zoom repaints the field in the same frame');
      advance(10500); h.graph.zoom(1); graphFrame(1);
      assert.deepEqual(rects(paints().at(-1)), rects(first), 'the same still frame');
      const readme = h.data().nodes.find(n => n.root === 'alpha' && n.file?.path === 'README.md');
      assert.deepEqual(rings(paints().at(-1), ...screen(readme)), rings(first, ...screen(readme)), 'the red halo is still');
      assert.equal(rings(first, ...screen(readme)).length, 2);
      api.setVisible(false);
      global.getComputedStyle = () => ({getPropertyValue:name => `next:${name}`}); api.setTheme();
      api.setVisible(true);
      assert.equal(frames.length, 0);
      const last = paints().at(-1);
      assert.ok(last.some(c => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === 'next:--foreground'), 'showing the map repaints a theme changed while hidden');
      assert.deepEqual(rects(last), rects(first), 'the repaint is the same still frame');
      const before = paints().length;
      h.settings.onNodeHover(readme);
      assert.equal(paints().length, before + 1, 'hover repaints the field');
      const link = h.data().links.find(l => l.reference.from.path === 'README.md');
      assert.equal(h.settings.linkCanvasObjectMode(link), 'after', 'the still field leaves direction to a chevron');
      const chevron = [], ctx = new Proxy({}, {get:(_, name) => (...args) => chevron.push(name), set:() => true});
      h.settings.linkCanvasObject({source:{x:0, y:0}, target:{x:100, y:0}}, ctx, 1);
      assert.equal(chevron.filter(name => name === 'lineTo').length, 2);
    });
  });
});

test('the field moves at no more than 30 fps and stops while the map, the tab or the page is gone', async () => {
  await withMotion(false, ({h, api, frames, cancelled, paints}) => {
    api.setIndex(fixture);
    assert.equal(frames.length, 1);
    const count = paints().length;
    frames.at(-1)(1000); assert.equal(paints().length, count + 1);
    frames.at(-1)(1020); assert.equal(paints().length, count + 1, 'a frame 20 ms later is skipped (it would be drawn at 60 fps)');
    frames.at(-1)(1034); assert.equal(paints().length, count + 2);
    const still = paints().at(-1).filter(c => c[0] === 'fillRect');
    for (let time = 1134; time <= 1534; time += 100) frames.at(-1)(time);
    assert.notDeepEqual(paints().at(-1).filter(c => c[0] === 'fillRect'), still, 'the points drift');
    // A graph frame that moved the camera repaints the field and stands in for the next loop frame.
    const painted = paints().length;
    h.graph.zoom(1.5); h.settings.onRenderFramePre(recorder(), 1.5); h.settings.onRenderFramePost(recorder(), 1.5);
    frames.at(-1)(1600); assert.equal(paints().length, painted + 1);
    frames.at(-1)(1700); assert.equal(paints().length, painted + 2);
    const requested = frames.length;
    api.setVisible(false); assert.deepEqual(cancelled, [requested]);
    api.setVisible(true); assert.equal(frames.length, requested + 1);
    h.document.hidden = true; h.listeners.get('visibilitychange')();
    assert.deepEqual(cancelled, [requested, requested + 1]);
    h.document.hidden = false; h.listeners.get('visibilitychange')();
    assert.equal(frames.length, requested + 2);
    const link = h.data().links[0];
    h.settings.onNodeHover(h.data().nodes.find(n => n.root === 'alpha' && n.file?.path === 'guide.md'));
    assert.equal(h.settings.linkCanvasObjectMode(link), undefined, 'the moving streams show direction; no chevron');
    api.destroy(); assert.deepEqual(cancelled, [requested, requested + 1, requested + 2]);
    assert.equal(h.listeners.has('visibilitychange'), false);
  });
});

test('when a minute passes, the status line, the Recent count and the Recent filter follow the field without a reindex', async () => {
  await atRecentNow(async advance => {
    await withMotion(false, ({h, api, frames}) => {
      api.setIndex(recentIndex());
      const status = h.all().find(el => el.className === 'map-status'), recent = h.all().find(el => el.attributes['data-filter'] === 'recent');
      const recentCount = () => recent.children.find(el => el.className === 'map-filter-count').textContent;
      let clock = 0;
      const frame = () => frames.at(-1)(clock += 40);
      recent.click();
      const search = h.all().find(el => el.attributes['aria-label'] === 'Path or title');
      const results = h.all().find(el => el.className === 'map-results');
      search.value = 'README'; search.oninput();
      assert.equal(text(status), '1 match in visible files (path/title)');
      results.value = results.children[0].value; results.onchange();
      assert.match(text(status), /^Markdown Atlas · 3 files · .* · 2 in 30 min · 1 in 24 h$/, 'choosing the result restores the status line');
      let searches = 0;
      const replace = results.replaceChildren.bind(results);
      results.replaceChildren = (...args) => { searches++; replace(...args); };
      advance(14 * 60e3); frame();
      assert.equal(searches, 1, 'the minute tick reruns active search');
      assert.match(text(status), / · 2 in 30 min · 1 in 24 h$/, 'README.md is still within 30 minutes, and the match count stays away');
      advance(16 * 60e3); frame();
      assert.match(text(status), / · 1 in 30 min · 2 in 24 h$/, 'README.md turns orange at the next minute');
      assert.equal(recentCount(), '3');
      advance(61 * 60e3); frame();
      assert.deepEqual(h.data().nodes.filter(n => n.type === 'file').map(n => n.file.path), ['README.md', 'loose.md'], 'the filter drops guide.md after 24 h');
      assert.match(text(status), /^Markdown Atlas · 2 files · .* · 1 in 30 min · 1 in 24 h$/);
      assert.equal(recentCount(), '2');
    });
  });
});

test('a soft accent core sits under each referenced file, built once per theme rather than per frame', async () => {
  await withMotion(false, ({h, api, frames, paints}) => {
    api.setIndex(fixture);
    const field = h.all().find(el => el.className === 'map-field').context;
    const gradients = () => field.calls.filter(c => c[0] === 'createRadialGradient').length;
    const cores = paint => paint.filter(c => c[0] === 'fillRect' && c[1] === -1 && c[2] === -1 && c[3] === 2).length;
    const built = gradients();
    frames.at(-1)(1000); frames.at(-1)(1100);
    assert.equal(gradients(), built, 'no gradient is built per frame');
    assert.equal(cores(paints().at(-1)), 1, 'alpha/guide.md is the one referenced file in view');
    const glow = field.calls.find(c => c[0] === 'set' && c[1] === 'fillStyle' && typeof c[2] === 'object')[2];
    assert.deepEqual(glow.stops, [[0, 'theme:--accent'], [1, 'theme:--accent']], 'the theme accent, opaque to clear');
    global.getComputedStyle = () => ({getPropertyValue:name => `next:${name}`}); api.setTheme();
    assert.equal(gradients(), built + 1, 'a theme change builds the next one');
  });
});

test('a lit reference streams in full accent at .7 and four times as fast; on hover everything else drops to a quarter', async () => {
  const {drawFilament, createFilament, sizeStreams} = await map;
  const a = {id:'a', type:'file', x:-100, y:0, modified:0, file:{inbound:0, orphan:true, open:false}}, b = {id:'b', type:'file', x:100, y:0, modified:0, file:{inbound:1, orphan:false, open:false}};
  const link = {source:a, target:b, style:'markdown', reference:{line:1}}, filament = createFilament([a, b], [link], 2);
  sizeStreams(filament, 1);
  const streamPoints = (lit, t, hovering = false) => {
    const ctx = recorder(); drawFilament(ctx, filament, frameOf({nodes:[a, b], lit, t, hovering}));
    return points(ctx.calls).filter(p => Math.abs(p.y - 300) < 3 && p.x > 320 && p.x < 480);
  };
  const quiet = {nodes:new Set(), links:new Set()}, lit = {nodes:new Set(['a', 'b']), links:new Set([link])};
  assert.ok(streamPoints(lit, 0).every(p => p.fill === 'ac' && p.alpha === .7));
  assert.ok(streamPoints(quiet, 0).some(p => p.fill === 'fg' && p.alpha === .22));
  assert.ok(streamPoints(quiet, 0, true).every(p => p.alpha <= .1 * .25 + .4 * .25), 'hovering elsewhere dims the reference');
  // One second moves a quiet point 0.05 of the 200 px reference, a lit one 0.2.
  const shifts = lights => { const before = streamPoints(lights, 0), after = streamPoints(lights, 1); return after.map((p, i) => p.x - before[i].x).filter(d => d > 0); };
  assert.ok(shifts(quiet).length && shifts(quiet).every(d => Math.abs(d - 10) <= 1));
  assert.ok(shifts(lit).length && shifts(lit).every(d => Math.abs(d - 40) <= 1));
});

test('the root label sits 18 px above its cluster, past a node strayed towards another root, and 28 px inside the canvas', async () => {
  await filterHost(({h, api}) => {
    const files = Array.from({length:12}, (_, i) => ({...fixture.files[1], path:`f${i}.md`, stale:false}));
    api.setIndex({...fixture, files, references:[]});
    h.data().nodes.forEach((node, i) => { node.x = 0; node.y = i * 10; });
    const labelY = () => { const ctx = recorder(); h.settings.onRenderFramePre(ctx, 1); h.settings.onRenderFramePost(ctx, 1); return ctx.calls.find(c => c[0] === 'fillText' && c[1] === 'ALPHA')[3]; };
    assert.equal(labelY(), -18);
    h.data().nodes[11].y = -2000;
    assert.equal(labelY(), -18, 'one node far above the other eleven does not carry the label with it');
    // The 600 px canvas centred at y 500 starts at y 200: the label holds at 228.
    h.graph.centerAt(0, 500);
    assert.equal(labelY(), 228);
  });
});

test('a selected file leaves the graph idle: no particles, and the frame loop pauses until the pointer or a key wakes it', async () => {
  for (const reduce of [false, true]) {
    await atRecentNow(async advance => {
      await withMotion(reduce, ({h, api, runTimers}) => {
        const loop = () => h.calls.filter(call => call === 'pauseAnimation' || call === 'resumeAnimation').at(-1);
        const key = k => h.listeners.get('keydown')({key:k, target:h.container, preventDefault(){}});
        api.setIndex(fixture);
        h.settings.onNodeClick(h.data().nodes.find(n => n.root === 'alpha' && n.file?.path === 'guide.md'));
        assert.ok(!Object.keys(h.settings).some(name => name.startsWith('linkDirectionalParticle')), 'no force-graph particles keep the graph redrawing');
        advance(5000); runTimers();
        assert.equal(loop(), undefined, 'the loop runs while the layout does');
        // A rendered frame ends the theme blend the first index started.
        h.settings.onRenderFramePre(recorder(), 1);
        h.settings.onEngineStop(); advance(5500); runTimers();
        assert.equal(loop(), undefined, 'and for a second after the fit that follows it');
        advance(6500); runTimers();
        assert.equal(loop(), 'pauseAnimation', `settled with a selection, the graph draws no frames${reduce ? ' under reduced motion' : ''}`);
        h.stage().listeners.get('pointermove')();
        assert.equal(loop(), 'resumeAnimation', 'the pointer on the map wakes it');
        advance(8000); runTimers();
        assert.equal(loop(), 'pauseAnimation');
        key('+');
        assert.equal(loop(), 'resumeAnimation', 'a zoom key wakes it for its camera move');
        advance(10000); runTimers();
        assert.equal(loop(), 'pauseAnimation');
        h.settings.onZoom({k:1, x:0, y:0});
        assert.equal(loop(), 'resumeAnimation', 'a pan dragged past the stage still moves the camera, and wakes it');
      });
    });
  }
});

test('recency rings are sprites stroked once per theme and radius, then only stamped', async () => {
  await atRecentNow(async () => {
    await withMotion(false, ({h, api, frames, paints}) => {
      const made = [], create = h.document.createElement;
      h.document.createElement = tag => { const el = create(tag); if (tag === 'canvas') made.push(el); return el; };
      api.setIndex(recentIndex());
      const built = made.length, stroked = () => made.map(el => el.context.calls.find(c => c[0] === 'set' && c[1] === 'strokeStyle')[2]);
      assert.deepEqual([...new Set(stroked())].sort(), ['theme:--orange', 'theme:--red']);
      let clock = 0;
      for (let i = 0; i < 10; i++) frames.at(-1)(clock += 40);
      assert.equal(made.length, built, 'ten frames build no sprite');
      const last = paints().at(-1);
      assert.equal(last.filter(c => c[0] === 'drawImage').length, 5, 'two red files stamp a glow and a ring each, the orange file one ring');
      assert.ok(!last.some(c => c[0] === 'arc'), 'no ring is stroked in a frame');
      global.getComputedStyle = () => ({getPropertyValue:name => `next:${name}`}); api.setTheme();
      assert.equal(made.length, 2 * built, 'a theme builds its own set once');
      assert.deepEqual([...new Set(stroked().slice(built))].sort(), ['next:--orange', 'next:--red']);
    });
  });
});

test('above 50 red files the rings hold still, so a fresh clone does not breathe every ring', async () => {
  await atRecentNow(async advance => {
    await withMotion(false, ({h, api, frames, paints, screen}) => {
      const index = count => ({...fixture, references:[], files:Array.from({length:count}, (_, i) => ({...fixture.files[1], path:`f${i}.md`, stale:false, modified:'2026-09-25T11:59:00Z'}))});
      let clock = 0;
      const ringsNow = () => { frames.at(-1)(clock += 40); return rings(paints().at(-1), ...screen(h.data().nodes[0])); };
      api.setIndex(index(50));
      advance(10000); const breathing = ringsNow(); advance(10500);
      assert.equal(breathing.length, 2); assert.notDeepEqual(ringsNow(), breathing, '50 red files still breathe');
      api.setIndex(index(51));
      advance(10000); const held = ringsNow(); advance(10500);
      assert.deepEqual(ringsNow(), held, '51 do not');
    });
  });
});

test('a field frame calls no Math.hypot and sets alpha from a few precomputed tiers, not a new number per point', async () => {
  const {drawFilament, createFilament, sizeStreams} = await map;
  const nodes = Array.from({length:600}, (_, i) => ({id:`f${String(i).padStart(4, '0')}`, type:'file', x:(i % 30) * 14 - 200, y:Math.floor(i / 30) * 14 - 140, modified:recentNow - (i % 5) * 3600e3, file:{inbound:i % 7, orphan:i % 7 === 0, open:false}}));
  const links = nodes.slice(1).map((node, i) => ({source:nodes[i], target:node, style:'markdown', reference:{line:i}}));
  const filament = createFilament(nodes, links, nodes.length); sizeStreams(filament, 1);
  const hypot = Math.hypot; let hypots = 0;
  Math.hypot = (...values) => { hypots++; return hypot(...values); };
  const ctx = recorder();
  try { drawFilament(ctx, filament, frameOf({nodes, t:3.7, width:1600, height:1000})); } finally { Math.hypot = hypot; }
  assert.equal(hypots, 0, 'Math.hypot allocates its arguments in the dust and stream loops');
  const drawn = points(ctx.calls), alphas = new Set(ctx.calls.filter(c => c[0] === 'set' && c[1] === 'globalAlpha').map(c => c[2]));
  assert.ok(drawn.length > 3000);
  // Seven rows of 17 tiers, four stream alphas, the ring alphas and one glow per inbound count.
  assert.ok(alphas.size <= 7 * 17 + 4 + 3 + 7, `${alphas.size} distinct alphas for ${drawn.length} points`);
});

test('a 2,000-file layout on slow frames converges before the cooldown cap, so the settle probe reports its time', async () => {
  const realNow = performance.now;
  let clock = 0;
  performance.now = () => clock;
  try {
    for (const frameMs of [16.7, 40, 90]) {
      await filterHost(({h, api}) => {
        const start = clock;
        api.setScope(null);
        // force-graph's engine: each frame stops at the cap or below the alpha
        // minimum, otherwise ticks once with the decay then set.
        let alpha = 1, elapsed = 0;
        while (elapsed < 1800 && !(alpha < h.settings.d3AlphaMin)) {
          clock += frameMs; elapsed = clock - start;
          alpha *= 1 - h.callArguments.get('d3AlphaDecay')[0];
          h.settings.onEngineTick();
        }
        h.settings.onEngineStop();
        assert.ok(alpha < .1 && elapsed < 1800, `${frameMs} ms frames: alpha ${alpha.toFixed(3)} after ${elapsed} ms`);
        const probe = api.probe();
        assert.equal(probe.settleReason, null); assert.ok(probe.settleMs < 1800, `${frameMs} ms frames: settled in ${probe.settleMs} ms`);
        assert.equal(h.callArguments.get('d3AlphaDecay')[0], .0228, 'a drag afterwards starts from the ordinary decay');
      });
    }
  } finally { performance.now = realNow; }
});

test('a neighbourhood is fitted when its layout settles; a restored view keeps its own camera', async () => {
  await filterHost(({h, api}) => {
    h.settings.onEngineStop(); h.completeCentre();
    h.graph.zoom(.25); h.graph.centerAt(900, 900);
    api.setScope(target);
    h.data().nodes.forEach((node, i) => { node.x = i * 100; node.y = i * 50; });
    assert.equal(h.graph.zoom(), .25, 'the old camera remains until the scoped layout stops');
    h.settings.onEngineStop(); h.completeCentre();
    // Seven nodes at x 0..600, y 0..300 plus force-graph's 4-unit margin in an 800 × 600 stage.
    assert.equal(h.graph.zoom(), (800 - 96) / 608);
    assert.deepEqual(h.graph.centerAt(), {x:300, y:150 - 12 / h.graph.zoom()});
    api.setScope(null); api.setScope(target);
    api.setView({zoom:2.5, center:{x:-7, y:3}, selected:target, pins:[]});
    h.settings.onEngineStop(); h.completeCentre();
    assert.deepEqual([h.graph.zoom(), h.graph.centerAt()], [2.5, {x:-7, y:3}], 'Back or Forward into a neighbourhood keeps its saved camera');
  });
});

test('a scoped layout fitted after adaptive decay reaches the engine stop', async () => {
  const realNow = performance.now;
  let clock = 0;
  performance.now = () => clock;
  try {
    await filterHost(({h, api}) => {
      api.setScope(target);
      h.data().nodes.forEach((node, i) => { node.x = i * 100; node.y = i * 50; });
      let alpha = 1;
      while (alpha >= h.settings.d3AlphaMin && clock < 1800) {
        clock += 90;
        alpha *= 1 - h.callArguments.get('d3AlphaDecay')[0];
        h.settings.onEngineTick();
      }
      h.settings.onEngineStop(); h.completeCentre();
      assert.ok(alpha < .1 && clock < 1800);
      assert.equal(api.probe().settleReason, null);
      assert.equal(h.graph.zoom(), (800 - 96) / 608);
      assert.deepEqual(h.graph.centerAt(), {x:300, y:150 - 12 / h.graph.zoom()});
    });
  } finally { performance.now = realNow; }
});

test('panning a neighbourhood before its engine stops keeps the user camera', async () => {
  await filterHost(({h, api}) => {
    api.setScope(target);
    h.data().nodes.forEach((node, i) => { node.x = i * 100; node.y = i * 50; });
    h.stage().listeners.get('pointerdown')();
    h.graph.zoom(1.8); h.graph.centerAt(240, -90);
    h.settings.onZoom({k:1.8});
    h.listeners.get('pointerup')();
    h.settings.onEngineStop(); h.completeCentre();
    assert.deepEqual([h.graph.zoom(), h.graph.centerAt()], [1.8, {x:240, y:-90}]);
  });
});

test('a canvas-consumed wheel keeps the scoped camera when the engine stops', async () => {
  await filterHost(({h, api}) => {
    api.setScope(target);
    h.data().nodes.forEach((node, i) => { node.x = i * 100; node.y = i * 50; });
    const stage = h.stage(), canvas = h.document.createElement('canvas'); stage.append(canvas);
    canvas.addEventListener('wheel', event => {
      h.graph.zoom(1.8); h.graph.centerAt(240, -90);
      event.stopPropagation();
    });
    const event = {stopped:false, stopPropagation() { this.stopped = true; }};
    if (stage.listenerOptions.get('wheel')?.capture) stage.listeners.get('wheel')(event);
    canvas.listeners.get('wheel')(event);
    if (!event.stopped) stage.listeners.get('wheel')(event);
    assert.equal(event.stopped, true);
    h.settings.onEngineStop(); h.completeCentre();
    assert.deepEqual([h.graph.zoom(), h.graph.centerAt()], [1.8, {x:240, y:-90}]);
  });
});

test('a neighbourhood hides root labels while retaining file labels', async () => {
  await filterHost(({h, api}) => {
    api.setScope(target);
    h.data().nodes.forEach((node, i) => { node.x = i * 100; node.y = i * 50; });
    const ctx = recorder(); h.settings.onRenderFramePre(ctx, 1);
    for (const node of h.data().nodes) h.settings.nodeCanvasObject(node, ctx, 1);
    h.settings.onRenderFramePost(ctx, 1);
    const text = ctx.calls.filter(call => call[0] === 'fillText').map(call => call[1]);
    assert.ok(text.some(value => value.includes('guide.md')));
    assert.ok(!text.includes('ALPHA') && !text.includes('BETA'));
  });
});

test('the roots are a group, the graph an application with a name, and j/k selection is announced', async () => {
  await filterHost(({h}) => {
    const roots = h.all().find(el => el.className === 'map-chips'), selection = h.all().find(el => el.className === 'map-selection');
    assert.deepEqual([roots.attributes.role, roots.attributes['aria-label']], ['group', 'Roots']);
    assert.equal(h.stage().attributes.role, 'application'); assert.match(h.stage().attributes['aria-label'], /^File graph/);
    assert.equal(selection.attributes.role, 'status');
    h.listeners.get('keydown')({key:'j', target:h.container, preventDefault(){}});
    assert.match(selection.textContent, /^alpha\/README\.md · readme/, 'the live region holds the file j selected');
  });
});

test('a root label moves below the status line rather than run into it', async () => {
  await filterHost(({h, api}) => {
    const status = h.all().find(el => el.className === 'map-status');
    api.setIndex({...fixture, files:[fixture.files[1]], references:[]});
    h.data().nodes.forEach(node => { node.x = 300; node.y = -250; });
    const labelY = () => { const ctx = recorder(); h.settings.onRenderFramePre(ctx, 1); h.settings.onRenderFramePost(ctx, 1); return ctx.calls.find(c => c[0] === 'fillText' && c[1] === 'ALPHA')[3]; };
    // 18 px above the node: y -268 in graph units, 32 px down the 600 px stage.
    assert.equal(labelY(), -268);
    // The status line changes (a search count) and now covers it: 10 to 36 px
    // down the right side of the 800 px stage.
    Object.assign(status, {offsetLeft:560, offsetWidth:230, offsetTop:10, offsetHeight:26});
    const frames = () => h.calls.filter(call => call === 'nodeCanvasObject').length, before = frames();
    const search = h.all().find(el => el.tagName === 'input'); search.value = 'guide'; search.oninput();
    assert.ok(frames() > before, 'the search input asks the paused graph for a frame, so the label moves without a pointer');
    assert.equal(labelY(), 36 + 14 - 300, 'its baseline goes 14 px below the status line');
  });
});

test('a text colour computed as color(srgb …) blends on the 0 to 255 scale, not through black', async () => {
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    await filterHost(({h, api}) => {
      // --text-soft is a color-mix(), which the browser reports as color(srgb r g b).
      const theme = text => {
        global.getComputedStyle = el => ({getPropertyValue:name => `theme:${name}`, color:el.className === 'map-filter-count' ? text : undefined});
        api.setTheme();
      };
      const guide = h.data().nodes.find(n => n.root === 'alpha' && n.file?.path === 'guide.md');
      const labelFill = () => { const calls = drawCalls(h, guide), at = calls.findIndex(c => c[0] === 'fillText'); return calls.slice(0, at).filter(c => c[0] === 'set' && c[1] === 'fillStyle').at(-1)[2]; };
      theme('color(srgb 0.8 0.8 0.8)'); now += 300;
      assert.equal(labelFill(), 'color(srgb 0.8 0.8 0.8)');
      theme('color(srgb 0.4 0.4 0.4)'); now += 100;
      assert.equal(labelFill(), 'rgb(153,153,153)', 'halfway between 204 and 102');
      now += 200;
      assert.equal(labelFill(), 'color(srgb 0.4 0.4 0.4)');
    });
  } finally { Date.now = realNow; }
});

test('two root labels held at the top edge stack a line apart instead of drawing over each other', async () => {
  await filterHost(({h, api}) => {
    const files = ['alpha', 'beta'].flatMap(root => Array.from({length:3}, (_, i) => ({...fixture.files[1], root, path:`f${i}.md`, stale:false})));
    api.setIndex({...fixture, files, references:[]});
    // Both clusters lie far above the 600 px canvas, 40 px apart across.
    h.data().nodes.forEach(node => { node.x = node.root === 'alpha' ? 0 : 40; node.y = -2000; });
    const ctx = recorder(); h.settings.onRenderFramePre(ctx, 1); h.settings.onRenderFramePost(ctx, 1);
    const y = name => ctx.calls.find(c => c[0] === 'fillText' && c[1] === name)[3];
    assert.equal(y('ALPHA'), -272, 'the first keeps its place 28 px inside the canvas');
    assert.equal(y('BETA'), -258, 'the second moves down a line, not up out of the canvas');
  });
});

test('a neighbourhood opened before its file is indexed settles only once the file is laid out', async () => {
  const h = host(), previous = {ForceGraph:global.ForceGraph, getComputedStyle:global.getComputedStyle, ResizeObserver:global.ResizeObserver};
  global.ForceGraph = () => () => h.graph;
  global.getComputedStyle = () => ({getPropertyValue:name => `theme:${name}`});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  let api;
  try {
    api = (await map).createMap(h.container, {onSelect(){}, onRead(){}, onEdit(){}});
    // The app shows the map as soon as Neighbourhood is pressed; /api/index may still be loading.
    api.setScope(target); api.setTarget(target); api.setVisible(true);
    h.settings.onEngineTick(); h.settings.onEngineStop();
    assert.equal(api.probe().counts.nodes, 0);
    assert.equal(api.probe().cooled, false, 'an empty layout is not the neighbourhood');
    assert.equal(api.probe().settleReason, 'neighbourhood file not indexed');
    api.setIndex(structuredClone(fixture)); api.setScope(target);
    h.settings.onEngineTick(); h.settings.onEngineStop();
    assert.equal(api.probe().counts.nodes, 7);
    assert.equal(api.probe().cooled, true);
  } finally { api?.destroy(); Object.assign(global, previous); }
});

test('a file label that would run into the impact source label is dropped', async () => {
  const {chooseLabels} = await map;
  const anchor = {id:'anchor', type:'anchor', label:'docs/impact.yml · source', x:0, y:0};
  const file = (id, x, y) => ({id, type:'file', name:`${id}.md`, file:{inbound:5, open:false}, modified:0, x, y});
  assert.deepEqual([...chooseLabels([anchor, file('near', 60, 4), file('far', 0, 40)], 1, recentNow)], ['far']);
});

test('the probe lists every drawn file with its recency and whether it neighbours the selection', async () => {
  await filterHost(({api}) => {
    api.setTarget(target);
    const nodes = api.probe().previewNodes, by = path => nodes.filter(node => node.path === path);
    assert.equal(nodes.length, 4, 'the four files in the default view, logs excluded');
    assert.deepEqual(by('guide.md').map(node => [node.root, node.neighbour]), [['alpha', false], ['beta', false]], 'the selection itself, and a file in another root');
    assert.ok(nodes.filter(node => node.root === 'alpha' && node.path !== 'guide.md').every(node => node.neighbour));
    assert.ok(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y) && node.heat === 0));
  });
});

test('the probe counts layouts started and graph frames drawn, so a stalled settle shows which stopped', async () => {
  await filterHost(({h, api}) => {
    const before = api.probe();
    api.setScope(target);
    assert.equal(api.probe().layouts, before.layouts + 1, 'a neighbourhood starts one layout');
    h.settings.onRenderFramePre(recorder(), 1); h.settings.onRenderFramePre(recorder(), 1);
    assert.equal(api.probe().graphFrames, before.graphFrames + 2);
  });
});
