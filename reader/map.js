export const fileKey = target => JSON.stringify(['file', target.root, target.path]);
export const radius = node => node.type === 'file' ? Math.min(19, 5 + 3 * Math.log2(1 + node.file.inbound)) : node.type === 'ghost' ? 6 : 4;
export const targetOf = node => node?.type === 'file' ? {root: node.file.root, path: node.file.path} : null;
export const edgeDash = style => ({markdown: [], path: [5, 4], wikilink: [1, 3], impact: []})[style];
const endpoint = value => typeof value === 'object' ? value.id : value;
export function describe(node) {
  if (node.type === 'ghost') return `${node.reference.from.root}/${node.reference.from.path} · ${node.reference.style} · line ${node.reference.line} · missing: ${node.text}`;
  if (node.type === 'anchor') return `${node.root}/docs/impact.yml · impact rules (source, not a document)`;
  const f = node.file;
  return `${f.root}/${f.path} · ${f.kind}${f.stale ? ' · stale' : ''}${f.orphan ? ' · orphan' : ''}${node.fx != null ? ' · pinned' : ''}`;
}
export function neighbourhood(data, id) {
  const nodes = new Set(id ? [id] : []), links = new Set();
  for (const link of data.links) {
    const a = endpoint(link.source), b = endpoint(link.target);
    if (a === id || b === id) { nodes.add(a); nodes.add(b); links.add(link); }
  }
  return {nodes, links};
}
export function orderedFiles(data) {
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return data.nodes.filter(node => node.type === 'file').sort((a, b) =>
    compare(a.file.root, b.file.root) || compare(a.file.path, b.file.path));
}
export function togglePin(node) {
  if (node.fx != null) { delete node.fx; delete node.fy; }
  else { node.fx = node.x; node.fy = node.y; }
}

export const colourToken = colour => /^#[\da-f]{6}$/i.test(colour) ? colour : `--${colour.replaceAll('_', '-')}`;
export const kindTokens = kinds => Object.fromEntries(kinds.map(kind => [kind.id, colourToken(kind.colour)]));
export function kindRule(kind) {
  const paths = kind.match.paths, extensions = kind.match.extensions;
  if (paths.length && extensions.length) return `${paths.join(', ')} · ${extensions.join(' ')}`;
  if (paths.length) return paths.join(', ');
  if (extensions.length) return `all ${extensions.join(' ')} files`;
  return 'all files';
}

// Cache graph objects separately from index records: force-graph mutates positions
// and link endpoints, while the app's index remains authoritative and untouched.
export function createModel() {
  const cache = new Map();
  let index = {roots: [], files: [], references: [], kinds: []}, signature = '', kindIDs = [];
  const filters = {roots: null, kinds: new Set(), orphan: false, dangling: false, stale: false};
  function put(id, values) {
    if (!cache.has(id)) cache.set(id, {id});
    return Object.assign(cache.get(id), values);
  }
  function setIndex(next) {
    const nextSignature = JSON.stringify([next.roots, next.files, next.references, next.kinds]);
    if (signature === nextSignature) return false;
    const previousIDs = new Set(kindIDs), firstIndex = !signature;
    signature = nextSignature; index = next;
    kindIDs = index.kinds.map(kind => kind.id);
    filters.kinds = new Set(kindIDs.filter(id => id !== 'log' && (firstIndex || !previousIDs.has(id) || filters.kinds.has(id))));
    const alive = new Set();
    for (const file of index.files) {
      const id = fileKey(file); alive.add(id);
      put(id, {type: 'file', root: file.root, file});
    }
    for (const ref of index.references) {
      if (ref.style === 'impact') {
        const id = JSON.stringify(['impact', ref.from.root]); alive.add(id);
        put(id, {type: 'anchor', root: ref.from.root});
      }
      if (ref.to === null) {
        const id = JSON.stringify(['ghost', ref.from.root, ref.from.path, ref.style, ref.line, ref.text]); alive.add(id);
        put(id, {type: 'ghost', root: ref.from.root, text: ref.text, reference: ref});
      }
    }
    for (const id of cache.keys()) if (!alive.has(id)) cache.delete(id);
    return true;
  }
  function view(scope = null) {
    if (scope) {
      const id = fileKey(scope), centre = cache.get(id);
      if (!centre) return {nodes: [], links: [], fileCount: 0, guarded: false, scope};
      const nodes = new Map([[id, centre]]), links = [];
      for (const ref of index.references) {
        const source = ref.style === 'impact' ? JSON.stringify(['impact', ref.from.root]) : fileKey(ref.from);
        const target = ref.to ? fileKey(ref.to) : JSON.stringify(['ghost', ref.from.root, ref.from.path, ref.style, ref.line, ref.text]);
        if (source !== id && target !== id) continue;
        const sourceNode = cache.get(source), targetNode = cache.get(target);
        if (!sourceNode || !targetNode) continue;
        nodes.set(source, sourceNode); nodes.set(target, targetNode);
        links.push({source, target, style: ref.style, reference: ref});
      }
      return {nodes: [...nodes.values()], links, fileCount: [...nodes.values()].filter(node => node.type === 'file').length, guarded: false, scope};
    }
    const files = index.files.filter(f => !filters.roots || filters.roots.has(f.root));
    if (files.length > 2000) return {nodes: [], links: [], fileCount: files.length, guarded: true};
    const nodes = new Map(files.filter(f => filters.kinds.has(f.kind) && (!filters.orphan || f.orphan) &&
      (!filters.dangling || f.dangling > 0) && (!filters.stale || f.stale)).map(f => [fileKey(f), cache.get(fileKey(f))]));
    const fileCount = nodes.size, links = [];
    for (const ref of index.references) {
      const source = ref.style === 'impact' ? JSON.stringify(['impact', ref.from.root]) : fileKey(ref.from);
      const target = ref.to ? fileKey(ref.to) : JSON.stringify(['ghost', ref.from.root, ref.from.path, ref.style, ref.line, ref.text]);
      if (ref.style === 'impact' ? !nodes.has(target) : !nodes.has(source)) continue;
      if (ref.to && !nodes.has(target)) continue;
      if (!nodes.has(source)) nodes.set(source, cache.get(source));
      if (!nodes.has(target)) nodes.set(target, cache.get(target));
      links.push({source, target, style: ref.style, reference: ref});
    }
    return {nodes: [...nodes.values()], links, fileCount, guarded: false};
  }
  function search(query) {
    const q = query.trim().toLocaleLowerCase();
    return q ? view().nodes.filter(n => n.type === 'file' && `${n.root}/${n.file.path} ${n.file.title}`.toLocaleLowerCase().includes(q)) : [];
  }
  return {filters, setIndex, view, search, get: target => cache.get(fileKey(target)), byID: id => cache.get(id), nodes: () => [...cache.values()], roots: () => index.roots.map(r => r.name), kinds: () => index.kinds};
}

export function palette(get, kinds) {
  const foreground = get('--foreground').trim();
  const tokens = kindTokens(kinds);
  return {background: get('--background').trim(), foreground, muted: get('--muted').trim(), accent: get('--accent').trim(),
    claude: get('--orange').trim() || foreground, agents: get('--red').trim() || foreground,
    stale: get('--yellow').trim(), kinds: Object.fromEntries(kinds.map(kind => [kind.id,
      tokens[kind.id].startsWith('#') ? tokens[kind.id] : get(tokens[kind.id]).trim() || foreground]))};
}
export function findPanPoint(canvas, doc, graph, data) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const candidates = [
    [.08, .08], [.92, .08], [.08, .92], [.92, .92], [.5, .08], [.5, .92], [.08, .5], [.92, .5], [.5, .5]
  ];
  for (const [across, down] of candidates) {
    const localX = rect.width * across, localY = rect.height * down;
    const x = rect.left + localX, y = rect.top + localY;
    if (doc.elementFromPoint(x, y) !== canvas) continue;
    const point = graph.screen2GraphCoords(localX, localY);
    const node = data.nodes.find(item => Number.isFinite(item.x) && Number.isFinite(item.y) &&
      Math.hypot(item.x - point.x, item.y - point.y) <= radius(item) + 3);
    if (!node) return {x, y, node: null};
  }
  return null;
}
export function probeSnapshot(graph, data, cooled, settleMs, settleReason = null, panPoint = null) {
  return {
    zoom: graph.zoom(),
    pins: data.nodes.filter(node => node.file && Number.isFinite(node.fx) && Number.isFinite(node.fy)).map(node => ({
      root: node.file.root, path: node.file.path, x: node.fx, y: node.fy
    })),
    counts: {nodes: data.nodes.length, edges: data.links.length}, cooled, settleMs, settleReason, panPoint
  };
}

export function settleResult(elapsed, cooldownMs) {
  return elapsed >= cooldownMs
    ? {settleMs: null, settleReason: 'cooldown-cap'}
    : {settleMs: elapsed, settleReason: null};
}

export const clusterRadius = fileCount => 35 + 12 * Math.sqrt(fileCount);

export function clusterLayout(nodes) {
  const roots = [...new Set(nodes.map(node => node.root))].sort();
  const fileCounts = new Map(roots.map(root => [root,
    nodes.filter(node => node.root === root && node.type === 'file').length]));
  const radii = new Map(roots.map(root => [root, clusterRadius(fileCounts.get(root))]));
  if (roots.length === 1) return new Map([[roots[0], {x: 0, y: 0, radius: radii.get(roots[0])}]]);
  const orbit = Math.max(roots.length * 180,
    Math.max(...radii.values()) / Math.sin(Math.PI / roots.length));
  return new Map(roots.map((root, i) => [root, {
    x: Math.cos(i * 2 * Math.PI / roots.length) * orbit,
    y: Math.sin(i * 2 * Math.PI / roots.length) * orbit,
    radius: radii.get(root)
  }]));
}

// A weak force in the existing simulation, not a second layout engine.
export function clusterForce() {
  let nodes = [], centres = new Map();
  function force(alpha) {
    for (const node of nodes) {
      const c = centres.get(node.root), angle = node.slot * 2.3999632297;
      const distance = c.radius + (node.file?.orphan ? 110 : 0);
      node.vx += (c.x + Math.cos(angle) * distance - node.x) * alpha * .008;
      node.vy += (c.y + Math.sin(angle) * distance - node.y) * alpha * .008;
    }
  }
  force.initialize = values => {
    nodes = values;
    centres = clusterLayout(nodes);
    const slots = new Map();
    nodes.forEach(node => { node.slot = slots.get(node.root) || 0; slots.set(node.root, node.slot + 1); });
  };
  return force;
}

function glyph(ctx, kind, r) {
  const s = r * .48;
  ctx.beginPath();
  if (kind === 'instruction') {
    ctx.moveTo(-s, -s); ctx.lineTo(0, 0); ctx.lineTo(-s, s); ctx.moveTo(s * .3, s); ctx.lineTo(s, s);
  } else if (kind === 'decision') {
    ctx.moveTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0); ctx.closePath();
  } else if (kind === 'readme') {
    ctx.moveTo(0, -s * .65); ctx.quadraticCurveTo(-s * .5, -s, -s, -s * .7); ctx.lineTo(-s, s);
    ctx.quadraticCurveTo(-s * .5, s * .6, 0, s); ctx.quadraticCurveTo(s * .5, s * .6, s, s);
    ctx.lineTo(s, -s * .7); ctx.quadraticCurveTo(s * .5, -s, 0, -s * .65); ctx.lineTo(0, s);
  } else {
    ctx.moveTo(-s * .7, -s); ctx.lineTo(s * .2, -s); ctx.lineTo(s * .7, -s * .5); ctx.lineTo(s * .7, s);
    ctx.lineTo(-s * .7, s); ctx.closePath(); ctx.moveTo(s * .2, -s); ctx.lineTo(s * .2, -s * .5); ctx.lineTo(s * .7, -s * .5);
  }
  ctx.stroke();
}

export function createMap(container, {onSelect, onRead, onEdit, onDetails = onSelect, onViewChange = () => {}}) {
  const cooldownMs = 1800;
  const doc = container.ownerDocument, model = createModel();
  let data = {nodes: [], links: []}, selected = null, hovered = null, lastTarget = null, scope = null, pendingTarget = null;
  let near = neighbourhood(data, null), visible = true, labels = false, destroyed = false, colours;
  let controlsHidden = false;
  try { controlsHidden = doc.defaultView?.sessionStorage.getItem('atlas-map-controls-hidden') === 'true'; } catch { /* Storage may be unavailable. */ }
  let lastClick = {id: null, time: 0}, initialFit = true, cameraDestination = null;
  let departures = [], arrivals = new Map(), themeStart = 0, previousColours = null, nextColours = null;
  let indexStartedAt = null, settleMs = null, settleReason = null, cooled = false;
  const element = (tag, className, text, parent = container) => {
    const el = doc.createElement(tag); el.className = className; el.textContent = text; parent.append(el); return el;
  };
  container.replaceChildren(); container.classList.add('atlas-map');
  const controls = element('div', 'map-controls', '');
  const scopeLabel = element('div', 'map-scope-label', 'Direct references · all kinds', controls); scopeLabel.hidden = true;
  const filterControls = element('div', 'map-filter-controls', '', controls);
  const rootsBox = element('div', 'map-chips', '', filterControls); rootsBox.setAttribute('aria-label', 'Roots');
  const kindDetails = element('details', 'map-kinds', '', filterControls);
  const kindSummary = element('summary', '', 'Kinds', kindDetails);
  element('div', 'map-filter-heading', 'File role · rule · file type · files in view', kindDetails);
  const kindsBox = element('div', 'map-filter-list', '', kindDetails);
  const status = element('div', 'map-status', ''); status.setAttribute('role', 'status');
  const canvas = element('div', 'map-canvas', '');
  const searchForm = element('form', 'map-search', '', canvas);
  const searchLabel = element('label', '', '', searchForm);
  const search = element('input', '', '', searchLabel); search.type = 'search'; search.placeholder = 'Path or title'; search.setAttribute('aria-label', 'Path or title');
  const results = element('select', 'map-results', '', searchForm); results.setAttribute('aria-label', 'Matching files'); results.hidden = true;
  const button = (text, action, parent = controls) => { const b = element('button', '', text, parent); b.type = 'button'; b.onclick = action; return b; };
  button('Find', () => chooseResult(), searchForm);
  const chips = [];
  function chip(text, active, toggle, parent) {
    const b = button(text, () => { toggle(); update(); }, parent);
    chips.push({b, active}); b.setAttribute('aria-pressed', String(active())); return b;
  }
  const rowCounts = [];
  function filterRow(id, label, rule, type, active, toggle, matches, parent) {
    const row = chip('', active, toggle, parent); row.className = 'map-filter-row';
    row.setAttribute('data-filter', id);
    const name = element('span', 'map-filter-name', label, row);
    element('span', 'map-filter-rule', rule, row);
    element('span', 'map-filter-type', type, row);
    const count = element('span', 'map-filter-count', '0', row);
    rowCounts.push({count, matches, parent});
    return name;
  }
  function rebuildKindRows() {
    for (let i = chips.length - 1; i >= 0; i--) if (chips[i].b.parentNode === kindsBox) chips.splice(i, 1);
    for (let i = rowCounts.length - 1; i >= 0; i--) if (rowCounts[i].parent === kindsBox) rowCounts.splice(i, 1);
    kindsBox.replaceChildren();
    const tokens = kindTokens(model.kinds());
    for (const kind of model.kinds()) {
      const name = filterRow(kind.id, kind.label, kindRule(kind), kind.match.extensions.join(' '),
        () => model.filters.kinds.has(kind.id), () => {
          if (!model.filters.kinds.delete(kind.id)) model.filters.kinds.add(kind.id);
        }, file => file.kind === kind.id, kindsBox);
      const colour = tokens[kind.id];
      name.style.setProperty('--kind-colour', colour.startsWith('#') ? colour : `var(${colour})`); name.classList.add('map-kind');
    }
  }
  element('div', 'map-filter-heading', 'Findings · files in view', kindDetails);
  const findingsBox = element('div', 'map-filter-list', '', kindDetails);
  for (const [finding, label, rule] of [
    ['orphan', 'Orphans', 'no inbound reference'],
    ['dangling', 'Dangling', 'a reference to a missing file'],
    ['stale', 'Stale', 'older than the code it describes']
  ]) filterRow(finding, label, rule, '', () => model.filters[finding],
    () => { model.filters[finding] = !model.filters[finding]; },
    file => finding === 'dangling' ? file.dangling > 0 : file[finding], findingsBox);
  const clearFilters = button('Clear filters', () => {
    model.filters.roots = null; model.filters.kinds = new Set(model.kinds().map(kind => kind.id).filter(id => id !== 'log'));
    model.filters.orphan = model.filters.dangling = model.filters.stale = false; pendingTarget = null; update();
  }, filterControls); clearFilters.hidden = true;
  const noMatch = element('span', 'map-no-match', 'No files match these filters', filterControls); noMatch.hidden = true;
  const stage = element('div', 'map-stage', '', canvas); stage.tabIndex = 0; stage.setAttribute('aria-label', 'File graph; search provides keyboard access to files');
  const graphControls = element('div', 'map-graph-controls', '', canvas);
  button('Fit f', () => graph.zoomToFit(350, 40), graphControls);
  button('Labels v', () => { labels = !labels; }, graphControls);
  const lastTargetAction = button('Last target 0', () => { if (lastTarget) setTarget(lastTarget); }, graphControls);
  const controlsToggle = button('Hide controls c', () => setControlsHidden(!controlsHidden), canvas);
  controlsToggle.className = 'map-controls-toggle';
  const footer = element('div', 'map-footer', '');
  const fileActions = element('div', 'map-file-actions', '', footer);
  const read = button('Read ↵', () => act(onRead), fileActions);
  const edit = button('Edit e', () => act(onEdit), fileActions);
  const details = button('Details d', () => act(onDetails), fileActions);
  const selectionText = element('span', 'map-selection', '', footer);
  const graph = globalThis.ForceGraph()(stage)
    .nodeId('id').nodeLabel(node => { const label = doc.createElement('span'); label.textContent = describe(node); return label; })
    .nodeCanvasObject(drawNode).nodePointerAreaPaint((node, colour, ctx) => {
      ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(node.x, node.y, radius(node) + 3, 0, Math.PI * 2); ctx.fill();
    })
    .linkLineDash(link => edgeDash(link.style)).linkWidth(link => link.style === 'impact' ? .65 : 1)
    .linkColor(link => colourAlpha(link.style === 'impact' ? colours.accent : colours.muted, hovered && !near.links.has(link) ? .08 : .65))
    .linkDirectionalArrowLength(link => hovered && near.links.has(link) ? 4 : 0)
    .linkDirectionalArrowRelPos(.85).d3AlphaMin(.1).cooldownTime(cooldownMs).autoPauseRedraw(false)
    .onNodeHover(node => { hovered = node?.id || null; near = neighbourhood(data, hovered); })
    .onNodeClick((node) => {
      const now = Date.now(); select(node);
      if (lastClick.id === node.id && now - lastClick.time < 350) act(onRead);
      lastClick = {id: node.id, time: now};
    })
    .onNodeRightClick((node, event) => { event.preventDefault(); togglePin(node); actions(); onViewChange(); })
    .onNodeDragEnd(node => { node.fx = node.x; node.fy = node.y; actions(); onViewChange(); })
    .onBackgroundClick(() => clearSelection())
    .onZoomEnd(() => { cameraDestination = null; onViewChange(); })
    .onEngineStop(() => {
      cooled = true;
      if (visible && indexStartedAt !== null) {
        ({settleMs, settleReason} = settleResult(Math.max(0, performance.now() - indexStartedAt), cooldownMs));
      } else {
        settleMs = null; settleReason ||= visible ? 'layout did not run entirely while visible' : 'layout stopped while map hidden';
      }
      if (initialFit && data.nodes.length) { graph.zoomToFit(350, 40); initialFit = false; }
      onViewChange();
    })
    .onRenderFramePre(animateTheme).onRenderFramePost((ctx, scale) => {
      const now = Date.now();
      departures = departures.filter(item => now - item.time < 200);
      for (const item of departures) drawNode(item.node, ctx, scale, 1 - (now - item.time) / 200);
      drawRoots(ctx, scale);
    });
  graph.d3Force('center', null); graph.d3Force('roots', clusterForce());
  graph.d3Force('charge').strength(-220).distanceMax(500);
  graph.d3Force('link').distance(120);
  // Canvas accepts CSS colours but alpha needs an independent representation.
  const colourCanvas = doc.createElement('canvas').getContext('2d');
  function colourAlpha(colour, alpha) {
    colourCanvas.fillStyle = colour;
    const normalized = colourCanvas.fillStyle;
    if (/^#[\da-f]{6}$/i.test(normalized)) return normalized + Math.round(alpha * 255).toString(16).padStart(2, '0');
    return normalized.replace(/rgba?\(([^)]+)\)/, (_, channels) => `rgba(${channels.split(',').slice(0, 3).join(',')},${alpha})`);
  }
  function drawNode(node, ctx, scale, opacity = Math.min(1, (Date.now() - (arrivals.get(node.id) || 0)) / 200)) {
    const r = radius(node), isolated = hovered && !near.nodes.has(node.id);
    ctx.save(); ctx.translate(node.x, node.y); ctx.globalAlpha = opacity * (isolated ? .12 : node.file?.orphan && selected !== node.id && hovered !== node.id ? .4 : 1);
    ctx.fillStyle = node.type === 'file' ? colours.kinds[node.file.kind] : colours.accent;
    if (node.file?.kind === 'instruction') {
      const basename = node.file.path.split('/').pop();
      if (basename === 'CLAUDE.md') ctx.fillStyle = colours.claude;
      if (basename === 'AGENTS.md') ctx.fillStyle = colours.agents;
    }
    ctx.strokeStyle = node.type === 'ghost' ? colours.muted : colours.foreground; ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    if (node.type === 'anchor') ctx.rect(-r, -r, r * 2, r * 2);
    else ctx.arc(0, 0, r, 0, Math.PI * 2);
    if (node.type !== 'ghost') ctx.fill(); ctx.stroke();
    if (node.file?.stale) { ctx.strokeStyle = colours.stale; ctx.lineWidth = 2 / scale; ctx.beginPath(); ctx.arc(0, 0, r + 2 / scale, 0, Math.PI * 2); ctx.stroke(); }
    if (selected === node.id) { ctx.strokeStyle = colours.foreground; ctx.lineWidth = 2 / scale; ctx.beginPath(); ctx.arc(0, 0, r + 5 / scale, 0, Math.PI * 2); ctx.stroke(); }
    if (node.type === 'file' && r * scale >= 9) { ctx.strokeStyle = colours.background; ctx.lineWidth = 1.4 / scale; glyph(ctx, node.file.kind, r); }
    if (labels || hovered === node.id || selected === node.id || r * scale >= 17 || node.type === 'anchor') {
      ctx.font = `${12 / scale}px ${fontFamily}`; ctx.fillStyle = colours.foreground;
      ctx.fillText(node.type === 'file' ? `${node.file.path}${node.file.stale ? ' · stale' : ''}${node.file.orphan ? ' · orphan' : ''}` : node.type === 'anchor' ? 'docs/impact.yml · source' : `${node.text} · missing`, r + 7 / scale, 4 / scale);
    }
    ctx.restore();
  }
  function drawRoots(ctx, scale) {
    const groups = new Map();
    for (const node of data.nodes) {
      if (!Number.isFinite(node.x)) continue;
      if (!groups.has(node.root)) groups.set(node.root, []);
      groups.get(node.root).push(node);
    }
    ctx.save(); ctx.font = `${13 / scale}px ${fontFamily}`; ctx.fillStyle = colours.muted; ctx.textAlign = 'center';
    for (const [root, nodes] of groups) ctx.fillText(root, nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length, Math.min(...nodes.map(n => n.y)) - 25 / scale);
    ctx.restore();
  }
  let fontFamily = 'monospace';
  function setTheme() {
    const style = getComputedStyle(container);
    previousColours = colours; nextColours = palette(name => style.getPropertyValue(name), model.kinds()); themeStart = Date.now();
    if (!colours) colours = nextColours;
    else colours = {...colours, kinds: {...nextColours.kinds, ...colours.kinds}};
    fontFamily = style.getPropertyValue('--font-monospace').trim() || 'monospace';
    graph.backgroundColor(nextColours.background);
  }
  function animateTheme() {
    const amount = Math.min(1, (Date.now() - themeStart) / 200);
    if (!previousColours || amount === 1) { colours = nextColours; return; }
    const mix = (from, to) => {
      if (!from) return to;
      const channels = colour => {
        colourCanvas.fillStyle = colour;
        const value = colourCanvas.fillStyle;
        return /^#[\da-f]{6}$/i.test(value) ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      };
      const a = channels(from), b = channels(to);
      return a?.length === 3 && b?.length === 3 ? `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(',')})` : to;
    };
    colours = Object.fromEntries(['background', 'foreground', 'muted', 'accent', 'stale', 'claude', 'agents'].map(k => [k, mix(previousColours[k], nextColours[k])]));
    colours.kinds = Object.fromEntries(model.kinds().map(kind => [kind.id, mix(previousColours.kinds[kind.id], nextColours.kinds[kind.id])]));
  }
  function selectedNode() { return data.nodes.find(n => n.id === selected); }
  function actions() {
    const node = selectedNode(), target = targetOf(node);
    read.disabled = edit.disabled = details.disabled = !target;
    selectionText.textContent = node ? describe(node) : '';
  }
  function act(callback) { const target = targetOf(selectedNode()); if (target) callback(target); }
  function select(node, centre = false, notify = true) {
    selected = node.id; actions();
    if (centre && Number.isFinite(node.x)) {
      cameraDestination = {x: node.x, y: node.y};
      graph.centerAt(node.x, node.y, 350);
    }
    const target = targetOf(node); if (notify && target) onSelect(target);
    onViewChange();
  }
  function clearSelection() { selected = null; actions(); stage.focus(); onViewChange(); }
  function searchResults() {
    results.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const matches = query ? orderedFiles(data).filter(node =>
      `${node.root}/${node.file.path} ${node.file.title}`.toLocaleLowerCase().includes(query)) : [];
    for (const node of matches) { const option = element('option', '', `${node.root}/${node.file.path}`, results); option.value = node.id; }
    results.hidden = !search.value.trim();
    if (!data.guarded && search.value.trim()) status.textContent = `${matches.length} matches in visible files (path/title).`;
  }
  function chooseResult() { const node = data.nodes.find(n => n.id === results.value); if (node) { select(node, true); stage.focus(); } }
  search.oninput = searchResults; searchForm.onsubmit = event => { event.preventDefault(); chooseResult(); }; results.onchange = chooseResult;
  search.onkeydown = event => {
    if (event.key !== 'Escape') return;
    if (kindDetails.open) event.stopPropagation();
    event.preventDefault();
    if (search.value) { search.value = ''; searchResults(); }
    else if (kindDetails.open) closeFilters();
    else stage.focus();
  };
  function closeFilters() { kindDetails.open = false; kindSummary.focus(); }
  function kindFilterCount() {
    const defaultKinds = model.kinds().filter(kind => kind.id !== 'log').map(kind => kind.id);
    return (model.filters.kinds.size !== defaultKinds.length || defaultKinds.some(id => !model.filters.kinds.has(id)) || model.filters.kinds.has('log') ? 1 : 0) +
      ['orphan', 'dangling', 'stale'].filter(finding => model.filters[finding]).length;
  }
  function activeFilterCount() { return (model.filters.roots ? 1 : 0) + kindFilterCount(); }
  function statusText() {
    if (data.guarded) return `${data.fileCount} files: narrow roots to 2,000 or fewer to draw the map.`;
    if (scope) return `Direct references · all kinds · ${data.fileCount} files · ${data.links.length} references`;
    return `${data.fileCount} files · ${data.links.length} references · logs ${model.filters.kinds.has('log') ? 'on' : 'off'}`;
  }
  function showStatus() {
    status.replaceChildren();
    status.textContent = pendingTarget ? `Target outside filters: ${pendingTarget.root}/${pendingTarget.path}. ` : statusText();
    if (pendingTarget) button('Reveal target', revealTarget, status);
  }
  function update() {
    const previous = data; data = model.view(scope);
    const now = Date.now(), currentIDs = new Set(data.nodes.map(n => n.id)), oldIDs = new Set(previous.nodes.map(n => n.id));
    departures = data.guarded ? [] : previous.nodes.filter(n => !currentIDs.has(n.id)).map(node => ({node, time: now}));
    arrivals = new Map(data.nodes.filter(n => !oldIDs.has(n.id)).map(n => [n.id, now]));
    hovered = null; near = neighbourhood(data, null);
    graph.graphData({nodes: data.nodes, links: data.links});
    stage.hidden = data.guarded;
    showStatus(); scopeLabel.hidden = !scope; filterControls.hidden = !!scope; lastTargetAction.hidden = !!scope;
    const filterCount = activeFilterCount(); clearFilters.hidden = !filterCount; clearFilters.textContent = `Clear filters${filterCount ? ` · ${filterCount}` : ''}`;
    noMatch.hidden = !!scope || !filterCount || data.fileCount !== 0;
    const kindFilters = kindFilterCount(); kindSummary.textContent = kindFilters ? `Kinds · ${kindFilters} ${kindFilters === 1 ? 'filter' : 'filters'}` : 'Kinds';
    const files = data.nodes.filter(node => node.type === 'file').map(node => node.file);
    for (const {count, matches} of rowCounts) count.textContent = String(files.filter(matches).length);
    for (const {b, active} of chips) b.setAttribute('aria-pressed', String(active()));
    actions(); if (search.value.trim()) searchResults();
  }
  let rootSignature = '', kindSignature = '';
  function setIndex(index) {
    if (!model.setIndex(index)) return;
    indexStartedAt = visible ? performance.now() : null; settleMs = null;
    settleReason = visible ? null : 'layout started while map hidden'; cooled = false;
    const roots = model.roots(), next = JSON.stringify(roots);
    if (next !== rootSignature) {
      rootSignature = next;
      for (let i = chips.length - 1; i >= 0; i--) if (chips[i].b.parentNode === rootsBox) chips.splice(i, 1);
      rootsBox.replaceChildren();
      chip('All roots', () => !model.filters.roots, () => { model.filters.roots = null; }, rootsBox);
      for (const root of roots) chip(root, () => !model.filters.roots || model.filters.roots.has(root), () => {
        if (!model.filters.roots) model.filters.roots = new Set([root]);
        else if (!model.filters.roots.delete(root)) model.filters.roots.add(root);
      }, rootsBox);
    }
    const nextKinds = JSON.stringify(model.kinds());
    if (nextKinds !== kindSignature) {
      kindSignature = nextKinds; rebuildKindRows(); setTheme();
    }
    update();
  }
  function setTarget(target) {
    lastTarget = target;
    const node = model.get(target);
    if (!node) { status.textContent = `Missing file: ${target.root}/${target.path}`; return; }
    if (!data.nodes.includes(node)) { pendingTarget = target; showStatus(); return; }
    pendingTarget = null;
    if (data.guarded) return;
    initialFit = false; select(node, true, false); showStatus();
  }
  function revealTarget() {
    if (!pendingTarget) return;
    const target = pendingTarget, node = model.get(target);
    if (!node) return;
    if (model.filters.roots) model.filters.roots.add(target.root);
    model.filters.kinds.add(node.file.kind);
    if (!node.file.orphan) model.filters.orphan = false;
    if (!(node.file.dangling > 0)) model.filters.dangling = false;
    if (!node.file.stale) model.filters.stale = false;
    pendingTarget = null; update(); setTarget(target);
  }
  function setScope(target) {
    scope = target ? {root: target.root, path: target.path} : null;
    pendingTarget = null; update();
    if (scope) {
      const node = model.get(scope);
      if (node) select(node, true, false);
    }
  }
  function setControlsHidden(value) {
    const centre = viewCentre(), zoom = graph.zoom();
    controlsHidden = value;
    searchForm.hidden = graphControls.hidden = footer.hidden = value;
    controlsToggle.textContent = value ? 'Show controls c' : 'Hide controls c';
    controlsToggle.setAttribute('aria-expanded', String(!value));
    if (value) stage.focus();
    try { doc.defaultView?.sessionStorage.setItem('atlas-map-controls-hidden', String(value)); } catch { /* Keep in-memory state when storage is unavailable. */ }
    resizeGraph(centre, zoom);
  }
  function focusSearch() { setControlsHidden(false); search.focus(); }
  function viewCentre() {
    const centre = cameraDestination || graph.centerAt();
    return {x: centre.x, y: centre.y};
  }
  function getView() {
    const centre = viewCentre();
    const chosen = selectedNode();
    return {controlsHidden, zoom: graph.zoom(), center: {x: centre.x, y: centre.y}, selected: chosen ? targetOf(chosen) || {id: chosen.id} : null,
      pins: model.nodes().filter(node => Number.isFinite(node.fx) && Number.isFinite(node.fy))
        .map(node => ({...(targetOf(node) || {id: node.id}), x: node.fx, y: node.fy}))};
  }
  function setView(view) {
    if (!view || typeof view !== 'object') return;
    if (typeof view.controlsHidden === 'boolean') setControlsHidden(view.controlsHidden);
    for (const node of model.nodes()) { delete node.fx; delete node.fy; }
    for (const saved of view.pins || []) {
      const node = saved.id ? model.byID(saved.id) : model.get(saved);
      if (node && Number.isFinite(saved.x) && Number.isFinite(saved.y)) { node.fx = saved.x; node.fy = saved.y; }
    }
    selected = view.selected ? (view.selected.id ? model.byID(view.selected.id) : model.get(view.selected))?.id || null : null; actions();
    cameraDestination = null;
    if (Number.isFinite(view.zoom)) graph.zoom(view.zoom, 0);
    if (Number.isFinite(view.center?.x) && Number.isFinite(view.center?.y)) graph.centerAt(view.center.x, view.center.y, 0);
    onViewChange();
  }
  function keydown(event) {
    if (!visible || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const nativeControl = event.target.closest('button, a, summary');
    if (event.key === 'Enter' && nativeControl) return;
    const move = step => {
      const files = orderedFiles(data); if (!files.length) return;
      const at = files.findIndex(node => node.id === selected);
      const next = files[Math.max(0, Math.min(files.length - 1, at < 0 ? (step > 0 ? 0 : files.length - 1) : at + step))];
      if (next && next.id !== selected) select(next, true);
    };
    const actions = {c: () => setControlsHidden(!controlsHidden), f: () => graph.zoomToFit(350, 40), '0': () => { if (lastTarget) setTarget(lastTarget); },
      v: () => { labels = !labels; }, Enter: () => act(onRead), l: () => nativeControl ? nativeControl.click() : act(onRead), ArrowRight: () => nativeControl ? nativeControl.click() : act(onRead),
      e: () => act(onEdit), d: () => act(onDetails), '+': () => graph.zoom(graph.zoom() * 1.3, 200),
      '-': () => graph.zoom(graph.zoom() / 1.3, 200), j: () => move(1), ArrowDown: () => move(1), k: () => move(-1), ArrowUp: () => move(-1), Escape: () => kindDetails.open ? closeFilters() : clearSelection()};
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
  }
  function filterKeydown(event) {
    if (!visible || !kindDetails.open || event.key !== 'Escape' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    // Handle the disclosure before the app's document listener clears selection.
    if (event.target === search && search.value) return;
    event.preventDefault(); event.stopPropagation(); closeFilters();
  }
  container.addEventListener('keydown', filterKeydown);
  doc.addEventListener('keydown', keydown);
  function resizeGraph(centre = viewCentre(), zoom = graph.zoom()) {
    if (!visible || !stage.clientWidth || !stage.clientHeight) return;
    graph.width(stage.clientWidth).height(stage.clientHeight);
    cameraDestination = null;
    graph.zoom(zoom, 0).centerAt(centre.x, centre.y, 0);
  }
  const resize = new ResizeObserver(() => resizeGraph());
  resize.observe(stage);
  function setVisible(value) {
    visible = value;
    if (visible) graph.resumeAnimation();
    else {
      if (!cooled) { indexStartedAt = null; settleMs = null; settleReason = 'layout paused while map hidden'; }
      graph.pauseAnimation();
    }
  }
  setControlsHidden(controlsHidden); setTheme(); actions();
  function probe() {
    const graphCanvas = stage.querySelector('canvas');
    return {...probeSnapshot(graph, data, cooled, settleMs, settleReason, findPanPoint(graphCanvas, doc, graph, data)), scope: scope ? {...scope} : null, view: getView()};
  }
  return {setIndex, setTarget, setScope, getView, setView, setTheme, setVisible, focusSearch, probe, destroy() {
    if (destroyed) return; destroyed = true; resize.disconnect(); container.removeEventListener('keydown', filterKeydown); doc.removeEventListener('keydown', keydown); graph._destructor(); container.replaceChildren(); container.classList.remove('atlas-map');
  }};
}
