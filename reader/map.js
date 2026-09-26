export const fileKey = target => JSON.stringify(['file', target.root, target.path]);
export const targetOf = node => node?.type === 'file' ? {root: node.file.root, path: node.file.path} : null;
const DASHES = {markdown: [], path: [5, 4], wikilink: [1, 3], impact: []};
export const edgeDash = style => DASHES[style];
const endpoint = value => typeof value === 'object' ? value.id : value;

// The contract's recency rule on the client clock: 2 is the red highlight (open,
// or edited within 30 minutes), 1 the orange one (within 24 hours), 0 none.
function heatAt(open, modified, now) {
  if (open === true) return 2;
  const age = now - modified;
  return age <= 1800000 ? 2 : age <= 86400000 ? 1 : 0;
}
export const recency = (file, now = Date.now()) => heatAt(file.open, Date.parse(file.modified), now);
const HEAT_TEXT = ['', ' · edited within 24 h', ' · edited within 30 min'];

export function describe(node, now = Date.now()) {
  if (node.type === 'ghost') return `${node.reference.from.root}/${node.reference.from.path} · ${node.reference.style} · line ${node.reference.line} · missing: ${node.target}`;
  if (node.type === 'anchor') return `${node.root}/docs/impact.yml · impact rules (source, not a document)`;
  const f = node.file;
  return `${f.root}/${f.path} · ${f.kind}${f.open === true ? ' · open in editor' : HEAT_TEXT[heatAt(false, Date.parse(f.modified), now)]}${f.stale ? ' · stale' : ''}${f.orphan ? ' · orphan' : ''}${node.fx != null ? ' · pinned' : ''}`;
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
// A kind row's two columns, in the panel's words: where it matches, and which types.
export const kindRule = kind => kind.match.paths.join(', ') || 'Any path';
export const kindTypes = kind => kind.match.extensions.join(', ') || 'Any file type';
// The path a dangling reference names: a Markdown link's target or a wikilink's name.
export function missingTarget(ref) {
  if (ref.style === 'wikilink') return ref.text.slice(2, -2).split('|')[0];
  const at = ref.text.lastIndexOf('](');
  return at < 0 ? ref.text : ref.text.slice(at + 2, -1);
}
const entryPoint = file => {
  if (file.kind !== 'instruction') return '';
  const basename = file.path.split('/').pop();
  return basename === 'CLAUDE.md' ? 'claude' : basename === 'AGENTS.md' ? 'agents' : '';
};

// Cache graph objects separately from index records: force-graph mutates positions
// and link endpoints, while the app's index remains authoritative and untouched.
export function createModel() {
  const cache = new Map();
  let index = {roots: [], files: [], references: [], kinds: []}, signature = '', kindIDs = [];
  const filters = {roots: null, kinds: new Set(), orphan: false, dangling: false, stale: false, recent: false};
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
      // Drawing reads these every frame, so parse and format them once here.
      put(id, {type: 'file', root: file.root, file, modified: Date.parse(file.modified), entry: entryPoint(file), name: file.path.split('/').pop(),
        label: `${file.path}${file.stale ? ' · stale' : ''}${file.orphan ? ' · orphan' : ''}`});
    }
    for (const ref of index.references) {
      if (ref.style === 'impact') {
        const id = JSON.stringify(['impact', ref.from.root]); alive.add(id);
        put(id, {type: 'anchor', root: ref.from.root, label: 'docs/impact.yml · source'});
      }
      if (ref.to === null) {
        const id = JSON.stringify(['ghost', ref.from.root, ref.from.path, ref.style, ref.line, ref.text]); alive.add(id);
        const target = missingTarget(ref);
        put(id, {type: 'ghost', root: ref.from.root, text: ref.text, target, reference: ref, name: target, label: `${target} · missing`});
      }
    }
    for (const id of cache.keys()) if (!alive.has(id)) cache.delete(id);
    return true;
  }
  function view(scope = null, now = Date.now()) {
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
      (!filters.dangling || f.dangling > 0) && (!filters.stale || f.stale) &&
      (!filters.recent || heatAt(f.open, Date.parse(f.modified), now) > 0)).map(f => [fileKey(f), cache.get(fileKey(f))]));
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
  return {filters, setIndex, view, get: target => cache.get(fileKey(target)), byID: id => cache.get(id), nodes: () => [...cache.values()], roots: () => index.roots.map(r => r.name), kinds: () => index.kinds};
}

// `text` is the resolved colour of map text that carries information (the
// reader's --text-soft, else the foreground); --muted stays for decoration.
export function palette(get, kinds, text = '') {
  const foreground = get('--foreground').trim();
  const tokens = kindTokens(kinds);
  return {background: get('--background').trim(), foreground, text: text || foreground, muted: get('--muted').trim(), accent: get('--accent').trim(),
    claude: get('--orange').trim() || foreground, agents: get('--red').trim() || foreground,
    red: get('--red').trim() || foreground, orange: get('--orange').trim(),
    stale: get('--yellow').trim(), kinds: Object.fromEntries(kinds.map(kind => [kind.id,
      tokens[kind.id].startsWith('#') ? tokens[kind.id] : get(tokens[kind.id]).trim() || foreground]))};
}

const PALETTE_KEYS = Object.keys(palette(() => '', [])).filter(key => key !== 'kinds');

// A drawn point's side in screen pixels: 2.5 px for an unreferenced file up to
// 9 px, growing into a tile that can hold a glyph as `detail` (zoom) reaches 1.
export function pointSide(node, detail = 0) {
  const base = node.type === 'file' ? Math.min(9, 2.5 + 1.5 * Math.log2(1 + node.file.inbound)) : node.type === 'ghost' ? 3.5 : 5;
  return base + detail * (base * .8 + 6);
}
export const detailAt = scale => Math.min(1, Math.max(0, (scale - 1.6) / 1.2));
// The hit region in graph units: the drawn point plus 3 px, at least 6 px.
export const hitRadius = (node, scale) => Math.max(pointSide(node, detailAt(scale)) / 2 + 3, 6) / scale;

// Seeded from node and link ids, so every load and screenshot draws the same field.
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function seeded(seed) {
  let a = seed;
  return () => {
    a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// The particle field. Nebulae gather around files by inbound rank and streams
// flow along references: 3,000 points between them, streams reserving up to
// 1,200. Above 600 files each nebula is halved; above 1,200 there are no
// streams. 600 dust points lie under both. Every array is allocated here, once
// per graph change; drawing allocates nothing.
export const DUST = 600;
// Fade and vignette come in 16 steps, so a frame sets a few precomputed alphas
// rather than a new number for every point.
const TIERS = 16, ROW = TIERS + 1;
export function createFilament(nodes, links, fileCount) {
  const streamLinks = fileCount > 1200 ? [] : links;
  const streamMax = Uint8Array.from(streamLinks, link => link.style === 'path' || link.style === 'wikilink' ? 12 : 24);
  const streamBudget = Math.min(1200, streamMax.reduce((sum, value) => sum + value, 0));
  const owners = [], sizes = [];
  let left = 3000 - streamBudget;
  const ranked = nodes.filter(node => node.type === 'file').sort((a, b) => b.file.inbound - a.file.inbound || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const weight = node => (node.file.orphan ? 3 : Math.min(90, Math.round(8 + 18 * Math.log2(1 + node.file.inbound)))) / (fileCount > 600 ? 2 : 1);
  // A small tree spends the budget too: its nebulae grow up to 3 times.
  const grow = Math.min(3, Math.max(1, left / ranked.reduce((sum, node) => sum + weight(node), 0)));
  for (const node of ranked) {
    let size = Math.round(weight(node) * grow);
    size = Math.min(size, left);
    if (size <= 0) break;
    owners.push(node); sizes.push(size); left -= size;
  }
  const count = 3000 - streamBudget - left;
  const owner = new Uint16Array(count), spread = new Float32Array(count), fade = new Uint8Array(count), phase = new Float32Array(count);
  const tiltCos = new Float32Array(owners.length), tiltSin = new Float32Array(owners.length), reaches = new Float32Array(owners.length), glow = new Float32Array(owners.length);
  for (let o = 0, i = 0; o < owners.length; o++) {
    const next = seeded(hash(owners[o].id)), reach = 18 + 12 * Math.log2(1 + owners[o].file.inbound), tilt = next() * Math.PI;
    tiltCos[o] = Math.cos(tilt); tiltSin[o] = Math.sin(tilt); reaches[o] = reach;
    glow[o] = Math.min(.24, .07 + .05 * Math.log2(1 + owners[o].file.inbound));
    for (let j = 0; j < sizes[o]; j++, i++) {
      const u = next();
      owner[i] = o; spread[i] = reach * u ** 2.2; fade[i] = Math.round(Math.sqrt(1 - u) * TIERS); phase[i] = next() * 2 * Math.PI;
    }
  }
  const streamSeed = Float32Array.from(streamLinks, link => seeded(hash(JSON.stringify([endpoint(link.source), endpoint(link.target), link.style, link.reference?.line])))());
  const next = seeded(1), dust = Float32Array.from({length: DUST * 3}, (_, i) => next() * (i % 3 === 2 ? 2 * Math.PI : 1));
  return {owners, owner, spread, fade, phase, tiltCos, tiltSin, reaches, glow, count, links: streamLinks, streamMax, streamCount: new Uint8Array(streamLinks.length), streamSeed, streamBudget, dust,
    alphas: new Float64Array(7 * ROW)};
}
// Stream density follows each reference's length on screen: a point every 6 px,
// 6 to 24 per reference (half for path and wikilink), scaled into the budget.
export function sizeStreams(filament, scale) {
  const {links, streamMax, streamCount, streamBudget} = filament;
  let total = 0;
  for (let j = 0; j < links.length; j++) {
    const a = links[j].source, b = links[j].target;
    const length = Number.isFinite(a?.x) && Number.isFinite(b?.x) ? Math.hypot(b.x - a.x, b.y - a.y) * scale : 0;
    streamCount[j] = Math.round(Math.min(24, Math.max(6, length / 6)) * streamMax[j] / 24);
    total += streamCount[j];
  }
  if (total > streamBudget) for (let j = 0; j < links.length; j++) streamCount[j] = Math.floor(streamCount[j] * streamBudget / total);
}

// Recency rings are stroked once into small canvases, per colour, stroke width
// and radius (to half a pixel) at the device ratio, and stamped with drawImage.
// `clear` drops them when the theme or the ratio changes.
export function ringSprites(createCanvas) {
  const byColour = new Map();
  return {
    clear() { byColour.clear(); },
    get(colour, width, radius, ratio) {
      let sprites = byColour.get(colour);
      if (!sprites) byColour.set(colour, sprites = new Map());
      const r = Math.round(radius * 2) / 2, key = width * 1000 + r * 2;
      let sprite = sprites.get(key);
      if (!sprite) {
        const half = Math.ceil((r + width / 2 + 1) * ratio), image = createCanvas(), ctx = image.getContext('2d');
        image.width = image.height = half * 2;
        ctx.setTransform(ratio, 0, 0, ratio, half, half); ctx.strokeStyle = colour; ctx.lineWidth = width; circle(ctx, 0, 0, r);
        sprites.set(key, sprite = {image, half});
      }
      return sprite;
    }
  };
}

// One field frame. `frame` holds the camera (k, cx, cy), the canvas (width,
// height in CSS pixels, device ratio), the field clock t in seconds, the
// recency clock, the red breath, the theme (light, colours, glow), the ring
// sprites and the lit neighbourhood. Points are drawn in device pixels at whole
// coordinates; light themes draw them at 1.4 times the alpha and put accent on
// one point in 13 instead of 19.
export function drawFilament(ctx, filament, frame) {
  const {k, width: w, height: h, ratio, t, light, lit, hovering, colours} = frame;
  const ox = w / 2 - frame.cx * k, oy = h / 2 - frame.cy * k, detail = detailAt(k);
  const every = light ? 13 : 19, boost = light ? 1.4 : 1, dim = hovering ? .25 : 1, unit = ratio, big = 1.6 * ratio;
  const {dust, alphas} = filament, reach = .6 * Math.sqrt(w * w + h * h);
  // Alpha rows, each by tier 0 to 16: dust (plain, every 11th, accent), then
  // nebula points (plain and every 11th, lit and dimmed).
  const dustPlain = (light ? .14 : .1) * dim, dustBright = (light ? .3 : .22) * dim, dustAccent = .3 * dim;
  const plain = Math.min(.7, .27 * boost), bright = Math.min(.7, .48 * boost);
  for (let tier = 0; tier <= TIERS; tier++) {
    const step = tier / TIERS;
    alphas[tier] = dustPlain * step; alphas[ROW + tier] = dustBright * step; alphas[2 * ROW + tier] = dustAccent * step;
    alphas[3 * ROW + tier] = plain * step; alphas[4 * ROW + tier] = bright * step;
    alphas[5 * ROW + tier] = plain * dim * step; alphas[6 * ROW + tier] = bright * dim * step;
  }
  let alpha = -1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Dust: a parallax layer panning at a quarter of the camera, drifting 3 px/s
  // and fading from the graph centre to nothing at 0.6 of the diagonal.
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass ? colours.accent : colours.foreground;
    for (let i = 0; i < DUST; i++) {
      if ((i % every === 0) !== (pass === 1)) continue;
      let x = dust[i * 3] * w + (ox - w / 2) * .25 + Math.cos(dust[i * 3 + 2]) * 3 * t;
      let y = dust[i * 3 + 1] * h + (oy - h / 2) * .25 + Math.sin(dust[i * 3 + 2]) * 3 * t;
      x -= Math.floor(x / w) * w; y -= Math.floor(y / h) * h;
      const dx = x - ox, dy = y - oy, tier = Math.round((1 - Math.sqrt(dx * dx + dy * dy) / reach) * TIERS);
      if (tier <= 0) continue;
      const a = alphas[(pass ? 2 : i % 11 === 0 ? 1 : 0) * ROW + tier];
      if (a !== alpha) ctx.globalAlpha = alpha = a;
      ctx.fillRect(Math.round(x * ratio), Math.round(y * ratio), 1, 1);
    }
  }
  // A soft accent core under each referenced file's nebula, the same tilted
  // ellipse, drawn with one unit gradient (frame.glow) scaled into place.
  const {owners, owner, spread, fade, phase, tiltCos, tiltSin, reaches, glow, count} = filament;
  if (frame.glow) {
    ctx.fillStyle = frame.glow;
    for (let o = 0; o < owners.length; o++) {
      const node = owners[o];
      if (!(node.file.inbound > 0) || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      const nx = node.x * k + ox, ny = node.y * k + oy, margin = Math.SQRT2 * pointSide(node, detail) / 2 + 3;
      const rx = margin + reaches[o] * k, ry = margin + .5 * reaches[o] * k;
      if (nx < -rx || ny < -rx || nx > w + rx || ny > h + rx) continue;
      ctx.globalAlpha = glow[o] * (lit.nodes.has(node.id) ? 1 : dim);
      ctx.setTransform(ratio * rx * tiltCos[o], ratio * rx * tiltSin[o], -ratio * ry * tiltSin[o], ratio * ry * tiltCos[o], ratio * nx, ratio * ny);
      ctx.fillRect(-1, -1, 2, 2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); alpha = -1;
  }
  // Nebulae: points crowd towards their file and turn faster near it, a squashed,
  // tilted vortex that keeps clear of the point itself. A red file spins twice
  // as fast with one point in 3 red; an orange one has one in 6 orange.
  for (let pass = 0; pass < 4; pass++) {
    ctx.fillStyle = pass === 0 ? colours.foreground : pass === 1 ? colours.accent : pass === 2 ? colours.red : colours.orange;
    let last = -1, skip = true, heat = 0, nx = 0, ny = 0, margin = 0, row = 3;
    for (let i = 0; i < count; i++) {
      const o = owner[i];
      if (o !== last) {
        const node = owners[o];
        last = o; skip = !Number.isFinite(node.x) || !Number.isFinite(node.y);
        if (skip) continue;
        nx = node.x * k + ox; ny = node.y * k + oy; heat = heatAt(node.file.open, node.modified, frame.now);
        margin = Math.SQRT2 * pointSide(node, detail) / 2 + 3; row = lit.nodes.has(node.id) ? 3 : 5;
      }
      if (skip || !fade[i]) continue;
      const kind = i % every === 0 ? 1 : heat === 2 && i % 3 === 0 ? 2 : heat === 1 && i % 6 === 0 ? 3 : 0;
      if (kind !== pass) continue;
      const s = spread[i], angle = phase[i] + t * (heat === 2 ? .9 : .45) / (1 + s / 12);
      const ex = Math.cos(angle) * (margin + s * k), ey = Math.sin(angle) * (margin + .5 * s * k);
      const x = nx + ex * tiltCos[o] - ey * tiltSin[o], y = ny + ex * tiltSin[o] + ey * tiltCos[o];
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
      const a = alphas[(row + (i % 11 === 0 ? 1 : 0)) * ROW + fade[i]];
      if (a !== alpha) ctx.globalAlpha = alpha = a;
      const size = i % 29 === 0 ? big : unit;
      ctx.fillRect(Math.round(x * ratio), Math.round(y * ratio), size, size);
    }
  }
  // Streams flow from source to target at 0.05 of the reference per second,
  // bowing sideways. Lit references run four times as fast in full accent;
  // impact references carry accent points only; a red source sends one in 4 red.
  const {links, streamCount, streamSeed} = filament;
  const litAlpha = .7, impactAlpha = Math.min(.7, .32 * boost) * dim, brightAlpha = Math.min(.7, .4 * boost) * dim, plainAlpha = Math.min(.7, .22 * boost) * dim;
  for (let pass = 0; pass < 3; pass++) {
    ctx.fillStyle = pass === 0 ? colours.foreground : pass === 1 ? colours.accent : colours.red;
    for (let j = 0; j < links.length; j++) {
      const a = links[j].source, b = links[j].target, n = streamCount[j];
      if (!n || !Number.isFinite(a?.x) || !Number.isFinite(b?.x)) continue;
      const ax = a.x * k + ox, ay = a.y * k + oy, dx = b.x * k + ox - ax, dy = b.y * k + oy - ay, length = Math.sqrt(dx * dx + dy * dy);
      if (length < 1 || Math.max(ax, ax + dx) < -40 || Math.min(ax, ax + dx) > w + 40 || Math.max(ay, ay + dy) < -40 || Math.min(ay, ay + dy) > h + 40) continue;
      const on = lit.links.has(links[j]), impact = links[j].style === 'impact', seed = streamSeed[j];
      const hot = a.file ? heatAt(a.file.open, a.modified, frame.now) === 2 : false;
      for (let p = 0; p < n; p++) {
        const id = j * 24 + p, kind = on || impact || id % every === 0 ? 1 : hot && id % 4 === 0 ? 2 : 0;
        if (kind !== pass) continue;
        let s = p / n + t * (on ? .2 : .05) + seed;
        s -= Math.floor(s);
        const bow = 2.5 * Math.sin(Math.PI * s) * Math.sin(1.1 * t + seed * 2 * Math.PI);
        const x = ax + dx * s - dy / length * bow, y = ay + dy * s + dx / length * bow;
        if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
        const pointAlpha = on ? litAlpha : impact ? impactAlpha : id % 11 === 0 ? brightAlpha : plainAlpha;
        if (pointAlpha !== alpha) ctx.globalAlpha = alpha = pointAlpha;
        const size = id % 29 === 0 ? big : unit;
        ctx.fillRect(Math.round(x * ratio), Math.round(y * ratio), size, size);
      }
    }
  }
  // Recency, told apart by form as well as hue: red is a breathing glow band
  // with a crisp ring, orange a single thin steady ring.
  const {rings, breath} = frame, grow = 6 + 3 * breath, crisp = light ? 1.5 : 1;
  const glowAlpha = (.1 + .18 * breath) * (light ? .6 : 1), ringAlpha = .6 + .4 * breath;
  for (let i = 0; i < frame.nodes.length; i++) {
    const node = frame.nodes[i];
    if (!node.file || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const heat = heatAt(node.file.open, node.modified, frame.now), x = node.x * k + ox, y = node.y * k + oy;
    if (!heat || x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
    const half = pointSide(node, detail) / 2, shade = hovering && !lit.nodes.has(node.id) ? .1 : 1;
    const px = Math.round(x * ratio), py = Math.round(y * ratio);
    if (heat === 2) {
      stamp(ctx, rings.get(colours.red, 6, half + grow, ratio), px, py, shade * glowAlpha);
      stamp(ctx, rings.get(colours.red, crisp, half + grow, ratio), px, py, shade * ringAlpha);
    } else stamp(ctx, rings.get(colours.orange, 1, half + 5, ratio), px, py, shade * .8);
  }
  ctx.globalAlpha = 1;
}
function stamp(ctx, sprite, x, y, alpha) {
  ctx.globalAlpha = alpha; ctx.drawImage(sprite.image, x - sprite.half, y - sprite.half);
}
export function findPanPoint(canvas, doc, graph, data) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect(), scale = graph.zoom();
  const candidates = [
    [.08, .08], [.92, .08], [.08, .92], [.92, .92], [.5, .08], [.5, .92], [.08, .5], [.92, .5], [.5, .5]
  ];
  for (const [across, down] of candidates) {
    const localX = rect.width * across, localY = rect.height * down;
    const x = rect.left + localX, y = rect.top + localY;
    if (doc.elementFromPoint(x, y) !== canvas) continue;
    const point = graph.screen2GraphCoords(localX, localY);
    const node = data.nodes.find(item => Number.isFinite(item.x) && Number.isFinite(item.y) &&
      Math.hypot(item.x - point.x, item.y - point.y) <= hitRadius(item, scale));
    if (!node) return {x, y, node: null};
  }
  return null;
}

// Labels at default zoom: every red file and the top files by inbound (an
// eighth of the files, 3 to 8). With `all`, every file and missing target is a
// candidate, by the same rank. Any whose text (the node's `key`) would overlap
// one already placed, or the impact source's label drawn always, is dropped.
// Text is 10 px monospace, about 6.2 px a character.
export function chooseLabels(nodes, scale, now, all = false, key = 'name') {
  const ranked = nodes.filter(node => (node.type === 'file' || all && node.type === 'ghost') && Number.isFinite(node.x) && Number.isFinite(node.y))
    .sort((a, b) => (b.file?.inbound ?? -1) - (a.file?.inbound ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const heat = node => node.file ? heatAt(node.file.open, node.modified, now) : 0;
  const top = Math.min(8, Math.max(3, Math.round(ranked.length / 8)));
  const placed = [], chosen = new Set(), detail = detailAt(scale);
  for (const node of nodes) if (node.type === 'anchor' && Number.isFinite(node.x) && Number.isFinite(node.y)) {
    const half = pointSide(node, detail) / 2, x = node.x * scale, y = node.y * scale;
    placed.push([x - half, y - 7, x + half + 10 + node.label.length * 6.2, y + 7]);
  }
  for (const node of [...ranked.filter(node => heat(node) === 2), ...all ? ranked : ranked.slice(0, top)]) {
    if (chosen.has(node.id)) continue;
    const half = pointSide(node, detail) / 2, x = node.x * scale, y = node.y * scale;
    const box = [x - half, y - 7, x + half + (heat(node) ? 14 : 10) + node[key].length * 6.2, y + 7];
    if (placed.some(other => box[0] < other[2] && other[0] < box[2] && box[1] < other[3] && other[1] < box[3])) continue;
    placed.push(box); chosen.add(node.id);
  }
  return chosen;
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
      const distance = c.radius + (node.file?.orphan ? 50 : 0);
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

// Stretches the layout into an ellipse matching the canvas: on a wide canvas
// y is pulled towards the centre line, on a tall one x, in proportion to how
// far the canvas is from square (counted up to 4:1).
export function aspectForce(ratio) {
  let nodes = [];
  function force(alpha) {
    const r = ratio();
    if (!(r > 0) || !Number.isFinite(r) || r === 1) return;
    const pull = alpha * .02 * Math.min(3, r > 1 ? r - 1 : 1 / r - 1);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (r > 1 && Number.isFinite(node.y)) node.vy -= node.y * pull;
      else if (r < 1 && Number.isFinite(node.x)) node.vx -= node.x * pull;
    }
  }
  force.initialize = values => { nodes = values; };
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

function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
function brackets(ctx, x, y, r, arm) {
  ctx.beginPath();
  for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) {
    ctx.moveTo(x + sx * r, y + sy * (r - arm)); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - arm), y + sy * r);
  }
  ctx.stroke();
}
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// force-graph's own decay: alpha falls from 1 to its minimum, .1, in 100 ticks.
const DECAY = .0228, ALPHA_MIN = .1;

export function createMap(container, {onSelect, onRead, onEdit, onDetails = onSelect, onViewChange = () => {}}) {
  // The layout aims to reach ALPHA_MIN 300 ms inside the cooldown cap.
  const cooldownMs = 1800, layoutBudget = cooldownMs - 300;
  const doc = container.ownerDocument, win = doc.defaultView, model = createModel();
  let data = {nodes: [], links: []}, selected = null, hovered = null, hoveredRoot = null, lastTarget = null, scope = null, pendingTarget = null;
  let lit = neighbourhood(data, null), visible = true, labels = false, destroyed = false, colours;
  let controlsHidden = false;
  try { controlsHidden = win?.sessionStorage.getItem('atlas-map-controls-hidden') === 'true'; } catch { /* Storage may be unavailable. */ }
  let lastClick = {id: null, time: 0}, initialFit = true, cameraDestination = null, pointerCameraInput = false;
  let departures = [], arrivals = new Map(), themeStart = 0, previousColours = null, nextColours = null;
  let indexStartedAt = null, settleMs = null, settleReason = null, cooled = false, layouts = 0, graphFrames = 0;
  let frameNow = Date.now(), heatClock = frameNow, heatMinute = -1, hotCount = 0, warmCount = 0, rootMarks = [], rootIndex = new Map();
  let filament = createFilament([], [], 0), named = new Set(), ticked = false, blending = false, searching = false, matchCount = 0;
  let looping = true, lastWake = 0, idleTimer = 0, engineRunning = false, layoutStart = 0, layoutTicks = 0, layoutAlpha = 1, layoutDecay = DECAY;
  const bounds = {left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity, labelTop: -Infinity, labelLeft: -Infinity, labelRight: Infinity};
  const camera = {k: 1, cx: 0, cy: 0, w: 0, h: 0}, painted = {k: 0, cx: NaN, cy: NaN};
  const motion = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduced = !!motion?.matches;
  const element = (tag, className, text, parent = container) => {
    const el = doc.createElement(tag); el.className = className; el.textContent = text; parent.append(el); return el;
  };
  container.replaceChildren(); container.classList.add('atlas-map');
  const controls = element('div', 'map-controls', '');
  const scopeLabel = element('div', 'map-scope-label', 'Direct references · all kinds', controls); scopeLabel.hidden = true;
  const filterControls = element('div', 'map-filter-controls', '', controls);
  const rootsBox = element('div', 'map-chips', '', filterControls); rootsBox.setAttribute('role', 'group'); rootsBox.setAttribute('aria-label', 'Roots');
  const canvas = element('div', 'map-canvas', '');
  const fieldCanvas = element('canvas', 'map-field', '', canvas), fieldCtx = fieldCanvas.getContext('2d');
  const searchForm = element('form', 'map-search', '', canvas);
  const searchLabel = element('label', '', '', searchForm);
  const search = element('input', '', '', searchLabel); search.type = 'search'; search.placeholder = 'Path or title'; search.setAttribute('aria-label', 'Path or title');
  const results = element('select', 'map-results', '', searchForm); results.setAttribute('aria-label', 'Matching files'); results.hidden = true;
  const status = element('div', 'map-status', '', canvas); status.setAttribute('role', 'status');
  const button = (text, action, parent = controls) => { const b = element('button', '', text, parent); b.type = 'button'; b.onclick = action; return b; };
  button('Find', () => chooseResult(), searchForm);
  const chips = [];
  function chip(text, active, toggle, parent) {
    const b = button(text, () => { toggle(); update(); }, parent);
    chips.push({b, active}); b.setAttribute('aria-pressed', String(active())); return b;
  }
  const rowCounts = [];
  const recent = chip('', () => model.filters.recent, () => { model.filters.recent = !model.filters.recent; }, filterControls);
  recent.className = 'map-recent'; recent.title = 'Open in editor or edited within 24 h'; recent.setAttribute('data-filter', 'recent');
  element('span', 'map-filter-name', 'Recent', recent);
  const recentCount = element('span', 'map-filter-count', '0', recent);
  rowCounts.push({count: recentCount, matches: file => recency(file, heatClock) > 0, parent: filterControls});
  const kindDetails = element('details', 'map-kinds', '', filterControls);
  const kindSummary = element('summary', '', 'Kinds', kindDetails);
  element('div', 'map-filter-heading', 'File role · paths · file types · files in view', kindDetails);
  const kindsBox = element('div', 'map-filter-list', '', kindDetails);
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
      const name = filterRow(kind.id, kind.label, kindRule(kind), kindTypes(kind),
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
    model.filters.orphan = model.filters.dangling = model.filters.stale = model.filters.recent = false; pendingTarget = null; update();
  }, filterControls); clearFilters.hidden = true;
  const noMatch = element('span', 'map-no-match', 'No files match these filters', filterControls); noMatch.hidden = true;
  const stage = element('div', 'map-stage', '', canvas); stage.tabIndex = 0;
  // The map's letter keys act on it, so a screen reader passes them through.
  stage.setAttribute('role', 'application'); stage.setAttribute('aria-label', 'File graph; j and k select files, search finds one');
  const graphControls = element('div', 'map-graph-controls', '', canvas);
  button('Fit f', () => { if (scope) initialFit = false; fit(400); }, graphControls);
  button('Labels v', toggleLabels, graphControls);
  const lastTargetAction = button('Last target 0', () => { if (lastTarget) setTarget(lastTarget); }, graphControls);
  const controlsToggle = button('Hide controls c', () => setControlsHidden(!controlsHidden), canvas);
  controlsToggle.className = 'map-controls-toggle';
  const footer = element('div', 'map-footer', '');
  const fileActions = element('div', 'map-file-actions', '', footer);
  const read = button('Read ↵', () => act(onRead), fileActions);
  const edit = button('Edit e', () => act(onEdit), fileActions);
  const details = button('Details d', () => act(onDetails), fileActions);
  const selectionText = element('span', 'map-selection', '', footer); selectionText.setAttribute('role', 'status');
  const graph = globalThis.ForceGraph()(stage)
    .nodeId('id').nodeLabel(node => { const label = doc.createElement('span'); label.textContent = describe(node); return label; })
    .nodeCanvasObject(drawNode).nodePointerAreaPaint((node, colour, ctx, scale) => {
      ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(node.x, node.y, hitRadius(node, scale), 0, Math.PI * 2); ctx.fill();
    })
    .linkLineDash(link => edgeDash(link.style)).linkWidth(1)
    .linkColor(link => lit.links.has(link) ? colours.edgeLit : hovered ? colours.edgeDim : link.style === 'impact' ? colours.impact : colours.edge)
    .linkCanvasObjectMode(link => reduced && lit.links.has(link) ? 'after' : undefined).linkCanvasObject(drawDirection)
    .d3AlphaMin(ALPHA_MIN).d3AlphaDecay(DECAY).cooldownTime(cooldownMs).autoPauseRedraw(true)
    .onNodeHover(node => { hovered = node?.id || null; hoveredRoot = node?.root ?? null; light(); })
    .onNodeClick((node) => {
      const now = Date.now(); select(node);
      if (lastClick.id === node.id && now - lastClick.time < 350) act(onRead);
      lastClick = {id: node.id, time: now};
    })
    .onNodeRightClick((node, event) => { event.preventDefault(); togglePin(node); actions(); onViewChange(); })
    .onNodeDragEnd(node => { node.fx = node.x; node.fy = node.y; actions(); onViewChange(); })
    .onBackgroundClick(() => clearSelection())
    .onZoom(() => { if (scope && pointerCameraInput) initialFit = false; wake(); })
    .onZoomEnd(() => { cameraDestination = null; relabel(); onViewChange(); })
    .onEngineTick(() => {
      ticked = engineRunning = true;
      // What is left of alpha is spread over the ticks the budget still allows
      // at the pace measured so far, so a large map converges before the cap.
      layoutAlpha *= 1 - layoutDecay; layoutTicks++;
      const elapsed = performance.now() - layoutStart, left = Math.floor((layoutBudget - elapsed) * layoutTicks / elapsed);
      if (layoutAlpha > ALPHA_MIN && !(left > Math.log(ALPHA_MIN / layoutAlpha) / Math.log(1 - layoutDecay))) {
        layoutDecay = 1 - (.99 * ALPHA_MIN / layoutAlpha) ** (1 / Math.max(1, left)); graph.d3AlphaDecay(layoutDecay);
      }
    })
    .onEngineStop(() => {
      cooled = true; engineRunning = false;
      if (layoutDecay !== DECAY) graph.d3AlphaDecay(layoutDecay = DECAY);
      // A neighbourhood opened before its file is indexed has laid out nothing;
      // it settles when the index brings the file and a layout runs on it.
      if (scope && !data.nodes.length) {
        cooled = false; settleMs = null; settleReason = 'neighbourhood file not indexed';
      } else if (visible && indexStartedAt !== null) {
        ({settleMs, settleReason} = settleResult(Math.max(0, performance.now() - indexStartedAt), cooldownMs));
      } else {
        settleMs = null; settleReason ||= visible ? 'layout did not run entirely while visible' : 'layout stopped while map hidden';
      }
      if (initialFit && data.nodes.length) { fit(400); initialFit = false; }
      relabel(); onViewChange();
    })
    .onRenderFramePre(beginFrame).onRenderFramePost((ctx, scale) => {
      if (departures.length) {
        let kept = 0;
        for (let i = 0; i < departures.length; i++) {
          const item = departures[i], age = frameNow - item.time;
          if (age < 200) { departures[kept++] = item; drawNode(item.node, ctx, scale, 1 - age / 200); }
        }
        departures.length = kept;
      }
      drawRoots(ctx, scale);
      // The field follows the layout and the camera in the same frame.
      if (ticked || camera.k !== painted.k || camera.cx !== painted.cx || camera.cy !== painted.cy) { ticked = false; paintField(); fresh = true; }
    });
  graph.d3Force('center', null); graph.d3Force('roots', clusterForce());
  graph.d3Force('aspect', aspectForce(() => stage.clientWidth / stage.clientHeight));
  graph.d3Force('charge').strength(-140).distanceMax(320);
  graph.d3Force('link').distance(70);
  // Setting any drawing accessor asks force-graph for one more frame.
  const redraw = () => { wake(); graph.nodeCanvasObject(drawNode); };
  // force-graph's frame loop runs only while the graph canvas can change: the
  // layout, a camera move (a pan dragged past the stage included), the theme
  // blend or a pointer on the map. A second after the last of these it pauses;
  // the field keeps its own loop.
  const timers = typeof win?.setTimeout === 'function' ? win : null;
  function wake() {
    lastWake = Date.now();
    if (!visible || destroyed) return;
    if (!looping) { looping = true; graph.resumeAnimation(); }
    if (timers && !idleTimer) idleTimer = timers.setTimeout(rest, 1000);
  }
  function rest() {
    idleTimer = 0;
    if (!looping || !visible || destroyed) return;
    const quiet = Date.now() - lastWake;
    if (engineRunning || blending || quiet < 1000) { idleTimer = timers.setTimeout(rest, Math.max(250, 1000 - quiet)); return; }
    looping = false; graph.pauseAnimation();
  }
  stage.addEventListener('pointermove', wake, {passive: true});
  stage.addEventListener('pointerdown', () => { pointerCameraInput = true; wake(); }, {passive: true});
  stage.addEventListener('wheel', () => { if (scope) initialFit = false; }, {capture: true, passive: true});
  const endPointerCameraInput = () => { pointerCameraInput = false; };
  doc.addEventListener('pointerup', endPointerCameraInput);
  doc.addEventListener('pointercancel', endPointerCameraInput);
  function startLayout() {
    layoutStart = performance.now(); layoutTicks = 0; layoutAlpha = 1; engineRunning = true;
    if (layoutDecay !== DECAY) graph.d3AlphaDecay(layoutDecay = DECAY);
    wake();
  }
  // Fit leaves 6% of the short side around the files (at least 48 px) and
  // 24 px more at the top for the root label.
  function fit(ms) {
    const box = graph.getGraphBbox(), width = stage.clientWidth, height = stage.clientHeight;
    if (!box || !width || !height) return;
    const pad = Math.max(48, .06 * Math.min(width, height));
    const k = Math.min(4, Math.max(.01, Math.min((width - 2 * pad) / (box.x[1] - box.x[0]), (height - 2 * pad - 24) / (box.y[1] - box.y[0]))));
    wake(); graph.centerAt((box.x[0] + box.x[1]) / 2, (box.y[0] + box.y[1]) / 2 - 12 / k, ms).zoom(k, ms);
  }
  // Canvas accepts CSS colours but alpha and mixing need channels, 0 to 255. A
  // mixed CSS token computes to the srgb colour-function form, with channels 0 to 1.
  const colourCanvas = doc.createElement('canvas').getContext('2d');
  function channels(colour) {
    if (!colour) return null;
    colourCanvas.fillStyle = colour;
    const value = colourCanvas.fillStyle, scale = /^color\(srgb\s/i.test(value) ? 255 : 1;
    const parts = /^#[\da-f]{6}$/i.test(value) ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : value.match(/[\d.]+/g)?.slice(0, 3).map(part => part * scale);
    return parts?.length === 3 ? parts : null;
  }
  function mix(from, to, amount) {
    const a = channels(from), b = channels(to);
    return a && b ? `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(',')})` : to;
  }
  function withAlpha(colour, alpha) {
    colourCanvas.fillStyle = colour;
    const normalized = colourCanvas.fillStyle;
    if (/^#[\da-f]{6}$/i.test(normalized)) return normalized + Math.round(alpha * 255).toString(16).padStart(2, '0');
    return normalized.replace(/rgba?\(([^)]+)\)/, (_, values) => `rgba(${values.split(',').slice(0, 3).join(',')},${alpha})`);
  }
  // Every string a frame needs is prepared here, once per theme (or per frame
  // only during the 200 ms theme blend), so the draw loops allocate nothing.
  const TINT = .6;
  function derive(base) {
    const ground = channels(base.background), light = !!ground && (.2126 * ground[0] + .7152 * ground[1] + .0722 * ground[2]) / 255 > .5;
    return {...base, light, orange: base.orange || mix(base.red, base.stale, .5),
      tints: Object.fromEntries(Object.entries(base.kinds).map(([id, colour]) => [id, mix(base.foreground, colour, TINT)])),
      claudeTint: mix(base.foreground, base.claude, TINT), agentsTint: mix(base.foreground, base.agents, TINT),
      edge: withAlpha(base.foreground, light ? .16 : .1), edgeDim: withAlpha(base.foreground, .04),
      edgeLit: withAlpha(base.accent, .6), impact: withAlpha(base.accent, .32)};
  }
  let fontFamily = 'monospace', fontScale = 0, labelFont = '', nameFont = '', rootFont = '', rootSpacing = '0px';
  function fonts(scale) {
    if (scale === fontScale) return;
    fontScale = scale; labelFont = `${10 / scale}px ${fontFamily}`; nameFont = `500 ${10 / scale}px ${fontFamily}`; rootFont = `700 ${10 / scale}px ${fontFamily}`; rootSpacing = `${1.2 / scale}px`;
  }
  function drawNode(node, ctx, scale, opacity = Math.max(0, Math.min(1, (frameNow - (arrivals.get(node.id) || 0)) / 200))) {
    const px = 1 / scale, x = node.x, y = node.y, file = node.file;
    const detail = detailAt(scale), half = pointSide(node, detail) * px / 2;
    const focus = selected === node.id || hovered === node.id, isolated = hovered && !lit.nodes.has(node.id);
    // Referenced files at full strength; orphans dimmest, still above any
    // resting particle (.48 dark, .67 light).
    const weight = focus || !file || file.inbound > 0 ? 1 : file.orphan ? colours.light ? .7 : .5 : colours.light ? 1 : .85;
    const alpha = opacity * (isolated ? .1 : weight);
    ctx.lineWidth = px;
    if (node.type === 'ghost') {
      ctx.globalAlpha = alpha * .8; ctx.strokeStyle = colours.muted; ctx.strokeRect(x - half, y - half, half * 2, half * 2);
    } else if (node.type === 'anchor') {
      ctx.globalAlpha = alpha; ctx.strokeStyle = ctx.fillStyle = colours.accent;
      ctx.strokeRect(x - half, y - half, half * 2, half * 2); ctx.fillRect(x - px, y - px, 2 * px, 2 * px);
    } else {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = node.entry === 'claude' ? colours.claudeTint : node.entry === 'agents' ? colours.agentsTint : colours.tints[file.kind];
      ctx.fillRect(x - half, y - half, half * 2, half * 2);
      if (detail > 0 && half * 2 * scale >= 9) {
        ctx.globalAlpha = alpha * detail; ctx.strokeStyle = colours.background; ctx.lineWidth = 1.2 * px;
        ctx.save(); ctx.translate(x, y); glyph(ctx, file.kind, half * 1.3); ctx.restore();
      }
    }
    if (file?.stale) {
      ctx.globalAlpha = alpha; ctx.fillStyle = colours.stale;
      ctx.fillRect(x - half - 4 * px, y + half + 3 * px, half * 2 + 8 * px, px);
    }
    if (focus) {
      ctx.globalAlpha = opacity; ctx.lineWidth = px; ctx.strokeStyle = selected === node.id ? colours.foreground : colours.muted;
      brackets(ctx, x, y, half + 9 * px, 4 * px);
    }
    // Labels are text that carries information, so they are drawn at full
    // strength in the text colour (focus in the foreground) unless hover isolates them.
    const full = focus || node.type === 'anchor' || detail > .5, name = !full && named.has(node.id);
    if ((full || name) && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      fonts(scale);
      const long = full || labels;
      ctx.globalAlpha = opacity * (isolated ? .1 : 1);
      ctx.font = long ? labelFont : nameFont; ctx.letterSpacing = '0px'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = focus ? colours.foreground : colours.text;
      // Clear of a recency ring when there is one.
      const gap = file && heatAt(file.open, node.modified, heatClock) ? 14 : 10;
      ctx.fillText(long ? node.label : node.name, x + half + gap * px, y);
    }
  }
  // Under reduced motion the field is still, so the lit references show their
  // direction with a chevron instead of a moving stream.
  function drawDirection(link, ctx, scale) {
    const a = link.source, b = link.target;
    if (!Number.isFinite(a?.x) || !Number.isFinite(b?.x)) return;
    const angle = Math.atan2(b.y - a.y, b.x - a.x), x = a.x + (b.x - a.x) * .8, y = a.y + (b.y - a.y) * .8, s = 4 / scale;
    ctx.globalAlpha = 1; ctx.strokeStyle = colours.accent; ctx.lineWidth = 1 / scale; ctx.setLineDash(DASHES.markdown);
    ctx.beginPath(); ctx.moveTo(x - s * Math.cos(angle - .5), y - s * Math.sin(angle - .5)); ctx.lineTo(x, y);
    ctx.lineTo(x - s * Math.cos(angle + .5), y - s * Math.sin(angle + .5)); ctx.stroke();
  }
  function drawRoots(ctx, scale) {
    if (scope) return;
    for (let i = 0; i < rootMarks.length; i++) { const mark = rootMarks[i]; mark.sum = mark.sumY = mark.sumY2 = mark.count = 0; mark.top = Infinity; }
    for (let i = 0; i < data.nodes.length; i++) {
      const node = data.nodes[i], mark = rootIndex.get(node.root);
      if (!mark || !Number.isFinite(node.x)) continue;
      mark.sum += node.x; mark.sumY += node.y; mark.sumY2 += node.y * node.y; mark.count++;
    }
    // The top node of the cluster proper: a node more than 2.5 deviations
    // above its centre has strayed towards another root.
    for (let i = 0; i < rootMarks.length; i++) {
      const mark = rootMarks[i], mean = mark.sumY / mark.count;
      mark.floor = mean - 2.5 * Math.sqrt(Math.max(0, mark.sumY2 / mark.count - mean * mean));
    }
    for (let i = 0; i < data.nodes.length; i++) {
      const node = data.nodes[i], mark = rootIndex.get(node.root);
      if (mark && Number.isFinite(node.x) && node.y >= mark.floor && node.y < mark.top) mark.top = node.y;
    }
    fonts(scale);
    const px = 1 / scale;
    ctx.save(); ctx.font = rootFont; ctx.letterSpacing = rootSpacing; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
    for (let i = 0; i < rootMarks.length; i++) {
      const mark = rootMarks[i];
      mark.placed = false;
      if (!mark.count) continue;
      // 18 px above the cluster, kept at least 28 px inside the canvas and
      // below the search box or status line it would otherwise run into.
      const x = Math.min(Math.max(mark.sum / mark.count, bounds.labelLeft), bounds.labelRight);
      const across = (x - camera.cx) * scale + camera.w / 2, reach = mark.name.length * 3.7;
      let down = (Math.max(mark.top - 18 * px, bounds.labelTop) - camera.cy) * scale + camera.h / 2;
      for (let box = overlayAt(across, reach, down); box; box = overlayAt(across, reach, down)) down = box.bottom + 14;
      // A label that would run into one already drawn moves a line (14 px)
      // at a time, up first, and stays 28 px inside the canvas.
      const wanted = down;
      for (let step = 1; rootBlocked(mark, across, reach, down) && step <= 2 * rootMarks.length + 2; step++) {
        const next = wanted + (step + 1 >> 1) * (step & 1 ? -14 : 14);
        if (next >= 28 && next <= camera.h - 28) down = next;
      }
      mark.placed = true; mark.across = across; mark.reach = reach; mark.down = down;
      const y = camera.cy + (down - camera.h / 2) * px;
      ctx.fillStyle = hoveredRoot === mark.root ? colours.accent : colours.text; ctx.fillText(mark.name, x, y);
      ctx.fillStyle = colours.accent; ctx.fillRect(x - 6.5 * px, y + 5 * px, 13 * px, px);
    }
    ctx.restore();
  }
  // The overlay a root label centred at `across` with its baseline at `down`
  // (screen pixels) runs into, if any.
  function overlayAt(across, reach, down) {
    for (let j = 0; j < overlays.length; j++) {
      const box = overlays[j];
      if (across + reach > box.left && across - reach < box.right && down > box.top && down - 10 < box.bottom) return box;
    }
    return null;
  }
  // Whether that label meets an overlay or a root label placed earlier in this frame.
  function rootBlocked(mark, across, reach, down) {
    if (overlayAt(across, reach, down)) return true;
    for (let j = 0; j < rootMarks.length; j++) {
      const other = rootMarks[j];
      if (other === mark) break;
      if (other.placed && Math.abs(across - other.across) < reach + other.reach + 12 && Math.abs(down - other.down) < 14) return true;
    }
    return false;
  }
  // The search box and status line sit over the top of the canvas. Their boxes
  // are measured after either changes, not every frame.
  const overlays = [];
  let overlaysStale = true;
  function measureOverlays() {
    overlaysStale = false; overlays.length = 0;
    for (const el of [searchForm, status]) {
      if (el.hidden || !el.offsetHeight || el.offsetTop > stage.clientHeight / 2) continue;
      overlays.push({left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth, top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight});
    }
  }
  function beginFrame(ctx, scale) {
    frameNow = Date.now(); graphFrames++; animateTheme();
    if (!scale) return;
    readCamera();
    if (overlaysStale) measureOverlays();
    // Labels outside the viewport (with a margin for their text) are skipped.
    const across = (camera.w / 2 + 300) / scale, down = (camera.h / 2 + 40) / scale, x = camera.cx, y = camera.cy;
    const finite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(across) && Number.isFinite(down);
    bounds.left = finite ? x - across : -Infinity; bounds.right = finite ? x + across : Infinity;
    bounds.top = finite ? y - down : -Infinity; bounds.bottom = finite ? y + down : Infinity;
    bounds.labelTop = finite ? y - (camera.h / 2 - 28) / scale : -Infinity;
    bounds.labelLeft = finite ? x - (camera.w / 2 - 60) / scale : -Infinity; bounds.labelRight = finite ? x + (camera.w / 2 - 60) / scale : Infinity;
  }
  function readCamera() {
    const centre = graph.centerAt();
    camera.k = graph.zoom(); camera.cx = centre?.x; camera.cy = centre?.y; camera.w = stage.clientWidth; camera.h = stage.clientHeight;
  }
  function setTheme() {
    const style = getComputedStyle(container);
    // Canvas text takes the Recent count's resolved colour, the CSS text token
    // (the status line's own colour changes on hover).
    previousColours = colours; nextColours = derive(palette(name => style.getPropertyValue(name), model.kinds(), getComputedStyle(recentCount).color)); themeStart = Date.now();
    // The graph redraws every frame only while the colours blend.
    if (colours) { blending = true; graph.autoPauseRedraw(false); wake(); }
    if (!colours) colours = nextColours;
    else colours = derive({...colours, kinds: {...nextColours.kinds, ...colours.kinds}});
    fontFamily = style.getPropertyValue('--font-monospace').trim() || 'monospace'; fontScale = 0;
    paintField();
  }
  function animateTheme() {
    const amount = Math.min(1, (frameNow - themeStart) / 200);
    if (blending && frameNow - themeStart >= 250) { blending = false; graph.autoPauseRedraw(true); }
    if (!previousColours || amount === 1) { colours = nextColours; return; }
    const blend = Object.fromEntries(PALETTE_KEYS.map(k => [k, previousColours[k] ? mix(previousColours[k], nextColours[k], amount) : nextColours[k]]));
    blend.kinds = Object.fromEntries(model.kinds().map(kind => [kind.id, previousColours.kinds[kind.id] ? mix(previousColours.kinds[kind.id], nextColours.kinds[kind.id], amount) : nextColours.kinds[kind.id]]));
    colours = derive(blend);
  }
  // The field canvas under the graph carries everything that moves: capped at
  // 30 fps, stopped while the map or tab is hidden, one still frame at t = 0
  // under reduced motion that repaints on theme, camera, hover and selection.
  let fieldWidth = 0, fieldHeight = 0, fieldRatio = 1, fieldRequest = 0, fieldLast = 0, fieldClock = 0, fieldPaints = 0, fresh = false, glowColours = null;
  const rings = ringSprites(() => doc.createElement('canvas'));
  const frame = {k: 1, cx: 0, cy: 0, width: 0, height: 0, ratio: 1, t: 0, now: 0, breath: .5, light: false, hovering: false, lit, nodes: [], colours: null, glow: null, rings};
  const animates = typeof win?.requestAnimationFrame === 'function';
  function sizeField() {
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = win?.devicePixelRatio || 1;
    if (!width || !height || (width === fieldWidth && height === fieldHeight && ratio === fieldRatio)) return;
    fieldCanvas.width = Math.round(width * ratio); fieldCanvas.height = Math.round(height * ratio);
    if (ratio !== fieldRatio) rings.clear();
    fieldWidth = width; fieldHeight = height; fieldRatio = ratio; paintField();
  }
  function paintField() {
    if (!fieldWidth || !visible || destroyed || !nextColours) return;
    const now = Date.now();
    if (Math.floor(now / 60000) !== heatMinute) tickMinute(now);
    readCamera(); painted.k = camera.k; painted.cx = camera.cx; painted.cy = camera.cy;
    frame.k = camera.k; frame.cx = camera.cx; frame.cy = camera.cy; frame.width = fieldWidth; frame.height = fieldHeight; frame.ratio = fieldRatio;
    // A two-second breath for red files; reduced motion, or more than 50 red
    // files (a fresh clone), holds it at the midpoint.
    frame.t = reduced ? 0 : fieldClock / 1000; frame.now = heatClock; frame.breath = reduced || hotCount > 50 ? .5 : .5 - .5 * Math.cos(now * Math.PI / 1000);
    if (glowColours !== nextColours) {
      rings.clear(); glowColours = nextColours; frame.glow = fieldCtx.createRadialGradient(0, 0, 0, 0, 0, 1);
      frame.glow.addColorStop(0, withAlpha(nextColours.accent, 1)); frame.glow.addColorStop(1, withAlpha(nextColours.accent, 0));
    }
    frame.light = nextColours.light; frame.colours = nextColours; frame.hovering = !!hovered; frame.lit = lit; frame.nodes = data.nodes;
    fieldCtx.setTransform(fieldRatio, 0, 0, fieldRatio, 0, 0);
    fieldCtx.clearRect(0, 0, fieldWidth, fieldHeight);
    if (camera.k > 0 && Number.isFinite(camera.k) && Number.isFinite(camera.cx) && Number.isFinite(camera.cy)) drawFilament(fieldCtx, filament, frame);
    fieldPaints++;
  }
  function fieldFrame(time) {
    fieldRequest = win.requestAnimationFrame(fieldFrame);
    const elapsed = time - fieldLast;
    if (elapsed < 1000 / 30 - 1) return;
    fieldLast = time; fieldClock += Math.min(elapsed, 100);
    // A graph frame that already repainted the field stands in for this one.
    if (fresh) fresh = false; else paintField();
  }
  function syncField() {
    const run = animates && !reduced && visible && !destroyed && !doc.hidden;
    if (run && !fieldRequest) fieldRequest = win.requestAnimationFrame(fieldFrame);
    if (!run && fieldRequest) { win.cancelAnimationFrame(fieldRequest); fieldRequest = 0; }
    if (!run) paintField();
  }
  function motionChange() { reduced = motion.matches; light(); syncField(); }
  motion?.addEventListener?.('change', motionChange);
  doc.addEventListener('visibilitychange', syncField);
  // Recency follows the clock, not the index: when a minute passes, the counts,
  // the Recent filter and the labels catch up with what the field draws.
  function tickMinute(now) {
    heatClock = now; heatMinute = Math.floor(now / 60000);
    if (model.filters.recent && !scope && !data.guarded) {
      const next = model.view(null, now).nodes;
      if (next.length !== data.nodes.length || next.some((node, i) => node !== data.nodes[i])) { update(); return; }
    }
    countRecent(); showStatus(); relabel();
    if (search.value.trim()) searchResults();
  }
  function countRecent() {
    hotCount = warmCount = 0;
    for (const node of data.nodes) {
      const heat = node.file ? heatAt(node.file.open, node.modified, heatClock) : 0;
      if (heat === 2) hotCount++; else if (heat === 1) warmCount++;
    }
    recentCount.textContent = String(hotCount + warmCount);
  }
  function relabel() {
    const scale = graph.zoom();
    // v labels every file that fits, and so does Recent when it shows 12 or fewer.
    const all = labels || model.filters.recent && !scope && data.fileCount <= 12;
    named = chooseLabels(data.nodes, scale, heatClock, all, labels ? 'label' : 'name'); sizeStreams(filament, scale); redraw();
  }
  function toggleLabels() { labels = !labels; relabel(); }
  function light() { lit = neighbourhood(data, hovered || selected); redraw(); paintField(); }
  function selectedNode() { return data.nodes.find(n => n.id === selected); }
  function actions() {
    const node = selectedNode(), target = targetOf(node);
    read.disabled = edit.disabled = details.disabled = !target;
    selectionText.textContent = node ? describe(node) : '';
  }
  function act(callback) { const target = targetOf(selectedNode()); if (target) callback(target); }
  function select(node, centre = false, notify = true) {
    selected = node.id; actions(); light();
    if (centre && Number.isFinite(node.x)) {
      cameraDestination = {x: node.x, y: node.y};
      graph.centerAt(node.x, node.y, 350);
    }
    const target = targetOf(node); if (notify && target) onSelect(target);
    onViewChange();
  }
  function clearSelection() { selected = null; actions(); light(); stage.focus(); onViewChange(); }
  function searchResults() {
    results.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const matches = query ? orderedFiles(data).filter(node =>
      `${node.root}/${node.file.path} ${node.file.title}`.toLocaleLowerCase().includes(query)) : [];
    for (const node of matches) { const option = element('option', '', `${node.root}/${node.file.path}`, results); option.value = node.id; }
    results.hidden = !query; matchCount = matches.length;
    if (!query) searching = false;
    showStatus();
  }
  function chooseResult() {
    const node = data.nodes.find(n => n.id === results.value);
    if (node) { searching = false; showStatus(); select(node, true); stage.focus(); }
  }
  search.oninput = () => { searching = true; searchResults(); }; searchForm.onsubmit = event => { event.preventDefault(); chooseResult(); }; results.onchange = chooseResult;
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
  function activeFilterCount() { return (model.filters.roots ? 1 : 0) + (model.filters.recent ? 1 : 0) + kindFilterCount(); }
  // Counts of files open or edited within 30 min and within 24 h, the numbers in
  // the ring colours; while a search is being typed, its match count instead.
  // A new status line can cover a root label, so it asks for a graph frame.
  function showStatus() {
    status.replaceChildren(); overlaysStale = true; redraw();
    const describeStatus = wording => { status.title = wording; status.setAttribute('aria-label', wording); };
    if (pendingTarget) { status.textContent = `Target outside filters: ${pendingTarget.root}/${pendingTarget.path}. `; button('Reveal target', revealTarget, status); describeStatus(status.textContent + 'Reveal target'); return; }
    if (data.guarded) { status.textContent = `${data.fileCount} files: narrow roots to 2,000 or fewer to draw the map.`; describeStatus(status.textContent); return; }
    if (searching) { status.textContent = `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} in visible files (path/title)`; describeStatus(status.textContent); return; }
    element('span', '', `${scope ? 'Neighbourhood' : 'Markdown Atlas'} · ${plural(data.fileCount, 'file')} · ${plural(data.links.length, 'ref')} · `, status);
    element('span', 'map-now', String(hotCount), status); element('span', '', ' in 30 min · ', status);
    element('span', 'map-today', String(warmCount), status); element('span', '', ' in 24 h', status);
    describeStatus(`${scope ? 'Neighbourhood' : 'Markdown Atlas'} · ${plural(data.fileCount, 'file')} · ${plural(data.links.length, 'ref')} · ${hotCount} open in editor or edited within 30 min · ${warmCount} edited within 24 h`);
  }
  function update() {
    layouts++; indexStartedAt = visible ? performance.now() : null; settleMs = null;
    settleReason = visible ? null : 'layout started while map hidden'; cooled = false;
    const previous = data; frameNow = heatClock = Date.now(); heatMinute = Math.floor(frameNow / 60000); data = model.view(scope, frameNow);
    const currentIDs = new Set(data.nodes.map(n => n.id)), oldIDs = new Set(previous.nodes.map(n => n.id));
    departures = data.guarded ? [] : previous.nodes.filter(n => !currentIDs.has(n.id)).map(node => ({node, time: frameNow}));
    arrivals = new Map(data.nodes.filter(n => !oldIDs.has(n.id)).map(n => [n.id, frameNow]));
    hovered = hoveredRoot = null; lit = neighbourhood(data, selected);
    rootMarks = [...new Set(data.nodes.map(n => n.root))].map(root => ({root, name: root.toUpperCase(), sum: 0, sumY: 0, sumY2: 0, count: 0, floor: -Infinity, top: Infinity, placed: false, across: 0, reach: 0, down: 0}));
    rootIndex = new Map(rootMarks.map(mark => [mark.root, mark]));
    const files = data.nodes.filter(node => node.type === 'file').map(node => node.file);
    filament = createFilament(data.nodes, data.links, data.fileCount);
    graph.graphData({nodes: data.nodes, links: data.links}); startLayout();
    countRecent(); relabel();
    stage.hidden = data.guarded;
    showStatus(); scopeLabel.hidden = !scope; filterControls.hidden = !!scope; lastTargetAction.hidden = !!scope;
    const filterCount = activeFilterCount(); clearFilters.hidden = !filterCount; clearFilters.textContent = `Clear filters${filterCount ? ` · ${filterCount}` : ''}`;
    noMatch.hidden = !!scope || !filterCount || data.fileCount !== 0;
    const kindFilters = kindFilterCount(); kindSummary.textContent = kindFilters ? `Kinds · ${kindFilters} ${kindFilters === 1 ? 'filter' : 'filters'}` : 'Kinds';
    for (const {count, matches} of rowCounts) count.textContent = String(files.filter(matches).length);
    for (const {b, active} of chips) b.setAttribute('aria-pressed', String(active()));
    actions(); if (search.value.trim()) searchResults();
    paintField();
  }
  let rootSignature = '', kindSignature = '';
  function setIndex(index) {
    if (!model.setIndex(index)) return;
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
    if (!node) { status.textContent = `Missing file: ${target.root}/${target.path}`; overlaysStale = true; return; }
    if (!data.nodes.includes(node)) { pendingTarget = target; showStatus(); return; }
    pendingTarget = null;
    if (data.guarded) return;
    // In a neighbourhood the whole view is fitted, so the target is not centred.
    if (!scope) initialFit = false;
    select(node, !scope, false); showStatus();
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
    if (!recency(node.file)) model.filters.recent = false;
    pendingTarget = null; update(); setTarget(target);
  }
  // A neighbourhood restarts the layout and is fitted when that layout settles,
  // once its new nodes have positions; a restored view (setView) keeps its camera.
  function setScope(target) {
    scope = target ? {root: target.root, path: target.path} : null;
    if (scope) initialFit = true;
    pendingTarget = null; update();
    graph.d3ReheatSimulation();
    if (scope) {
      const node = model.get(scope);
      if (node) select(node, false, false);
    }
  }
  function setControlsHidden(value) {
    const centre = viewCentre(), zoom = graph.zoom();
    controlsHidden = value;
    controls.hidden = searchForm.hidden = graphControls.hidden = footer.hidden = value; overlaysStale = true;
    controlsToggle.textContent = value ? 'Show controls c' : 'Hide controls c';
    controlsToggle.setAttribute('aria-expanded', String(!value));
    if (value) stage.focus();
    try { win?.sessionStorage.setItem('atlas-map-controls-hidden', String(value)); } catch { /* Keep in-memory state when storage is unavailable. */ }
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
    selected = view.selected ? (view.selected.id ? model.byID(view.selected.id) : model.get(view.selected))?.id || null : null; actions(); light();
    cameraDestination = null; initialFit = false;
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
    const actions = {c: () => setControlsHidden(!controlsHidden), f: () => { if (scope) initialFit = false; fit(400); }, '0': () => { if (lastTarget) setTarget(lastTarget); },
      v: toggleLabels, Enter: () => act(onRead), l: () => nativeControl ? nativeControl.click() : act(onRead), ArrowRight: () => nativeControl ? nativeControl.click() : act(onRead),
      e: () => act(onEdit), d: () => act(onDetails), '+': () => { if (scope) initialFit = false; graph.zoom(graph.zoom() * 1.3, 200); },
      '-': () => { if (scope) initialFit = false; graph.zoom(graph.zoom() / 1.3, 200); }, j: () => move(1), ArrowDown: () => move(1), k: () => move(-1), ArrowUp: () => move(-1), Escape: () => kindDetails.open ? closeFilters() : clearSelection()};
    if (actions[event.key]) { event.preventDefault(); wake(); actions[event.key](); }
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
    if (!visible) return;
    sizeField();
    if (!stage.clientWidth || !stage.clientHeight) return;
    wake(); overlaysStale = true;
    graph.width(stage.clientWidth).height(stage.clientHeight);
    cameraDestination = null;
    graph.zoom(zoom, 0).centerAt(centre.x, centre.y, 0);
  }
  const resize = new ResizeObserver(() => resizeGraph());
  resize.observe(stage);
  function setVisible(value) {
    visible = value;
    if (visible) { sizeField(); wake(); }
    else {
      if (!cooled) { indexStartedAt = null; settleMs = null; settleReason = 'layout paused while map hidden'; }
      graph.pauseAnimation(); looping = false;
    }
    syncField();
  }
  setControlsHidden(controlsHidden); setTheme(); actions(); sizeField(); syncField();
  function probe() {
    const graphCanvas = stage.querySelector('canvas');
    // Every drawn file with its recency and whether it is a direct neighbour of
    // the selection: scripts/preview frames the marketplace picture from them.
    const near = neighbourhood(data, selected).nodes;
    const previewNodes = data.nodes.filter(node => node.file && Number.isFinite(node.x) && Number.isFinite(node.y))
      .map(node => ({root: node.root, path: node.file.path, x: node.x, y: node.y, heat: heatAt(node.file.open, node.modified, heatClock), neighbour: node.id !== selected && near.has(node.id)}));
    // Layouts started and graph frames drawn tell a layout restarted over and
    // over from a graph frame loop that stopped, when a settle wait gives up.
    return {...probeSnapshot(graph, data, cooled, settleMs, settleReason, findPanPoint(graphCanvas, doc, graph, data)), fieldPaints, layouts, graphFrames, scope: scope ? {...scope} : null, view: getView(), previewNodes};
  }
  return {setIndex, setTarget, setScope, getView, setView, setTheme, setVisible, focusSearch, probe, destroy() {
    if (destroyed) return; destroyed = true; syncField(); resize.disconnect(); timers?.clearTimeout(idleTimer); motion?.removeEventListener?.('change', motionChange);
    container.removeEventListener('keydown', filterKeydown); doc.removeEventListener('keydown', keydown); doc.removeEventListener('visibilitychange', syncField);
    doc.removeEventListener('pointerup', endPointerCameraInput); doc.removeEventListener('pointercancel', endPointerCameraInput);
    graph._destructor(); container.replaceChildren(); container.classList.remove('atlas-map');
  }};
}
