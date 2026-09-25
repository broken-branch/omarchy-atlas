const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export const sameTarget = (a, b) => !!a && !!b && a.root === b.root && a.path === b.path;
// The server names a filename byte that is not UTF-8 as a lone surrogate
// U+DC80–U+DCFF (Python's surrogateescape). URLs carry it as that byte again.
const ESCAPED_BYTE = /((?<![\uD800-\uDBFF])[\uDC80-\uDCFF])/;
export function encodePart(value) {
  return value.split(ESCAPED_BYTE).map((part, i) => i % 2 ? '%' + (part.charCodeAt(0) - 0xDC00).toString(16).toUpperCase() : encodeURIComponent(part)).join('');
}
const decoded = bytes => { try { return decodeURIComponent('%' + bytes.join('%')); } catch { return null; } };
export function decodePart(value) {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, run => {
    const bytes = run.slice(1).split('%');
    let result = '';
    for (let at = 0; at < bytes.length;) {
      const length = [4, 3, 2, 1].find(n => at + n <= bytes.length && decoded(bytes.slice(at, at + n)) !== null);
      result += length ? decoded(bytes.slice(at, at + length)) : String.fromCharCode(0xDC00 + parseInt(bytes[at], 16));
      at += length || 1;
    }
    return result;
  });
}
export const fileURL = target => `/api/file?root=${encodePart(target.root)}&path=${encodePart(target.path)}`;
export function routeURL(view, target, anchor = '') {
  const base = target ? `/${view}/` + [target.root, ...target.path.split('/')].map(encodePart).join('/') : view === 'read' ? '/' : '/map';
  return base + (anchor ? '#' + encodeURIComponent(anchor) : '');
}
export function parseRoute(location) {
  const url = new URL(location, 'http://127.0.0.1:4137');
  try {
    const [view, root, ...parts] = url.pathname.slice(1).split('/').map(decodePart);
    if (view && !['read', 'map'].includes(view)) throw Error('Unknown view');
    if (parts.some(p => !p || p === '..' || p === '.' || p.includes('/')) || root?.includes('/')) throw Error('Invalid target');
    return {view: view || 'read', target: root && parts.length ? {root, path: parts.join('/')} : null, anchor: decodeURIComponent(url.hash.slice(1))};
  } catch { return {view: 'read', target: null, anchor: '', error: 'Invalid reader URL'}; }
}
export function assetURL(target, value) {
  if (value.startsWith('#')) return value;
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(value)) return '';
  const url = new URL(value, `http://atlas/raw/${encodePart(target.root)}/${target.path.split('/').map(encodePart).join('/')}`);
  return url.pathname.startsWith(`/raw/${encodePart(target.root)}/`) ? url.pathname + url.search + url.hash : '';
}
export function referenceHTML(ref, label = ref.text) {
  const anchor = ref.style === 'markdown' ? /#([^)]*)\)$/.exec(ref.text)?.[1] || '' : '';
  let decoded = anchor;
  try { decoded = decodeURIComponent(anchor); } catch { /* Keep a literal malformed anchor. */ }
  return `<a href="${escapeHTML(routeURL('read', ref.resolved && ref.to ? ref.to : ref.from, decoded))}"${ref.resolved ? '' : ' data-missing="true"'}>${escapeHTML(label)}${ref.resolved ? '' : ' <span class="missing">(missing)</span>'}</a>`;
}
export function recency(file, now = Date.now()) {
  if (file?.open) return {level:'hot', label:'open in editor'};
  const modified = Date.parse(file?.modified);
  if (!Number.isFinite(modified)) return null;
  const age = Math.max(0, now - modified);
  if (age > 24 * 60 * 60 * 1000) return null;
  const level = age <= 30 * 60 * 1000 ? 'hot' : 'warm';
  const minutes = Math.floor(age / 60000);
  const label = minutes < 1 ? 'edited just now' : minutes < 60 ? `edited ${minutes} min ago` : `edited ${Math.floor(minutes / 60)} h ago`;
  return {level, label};
}
export function recencyHTML(file, pill = false, now = Date.now()) {
  const value = recency(file, now);
  if (!value) return '';
  const root = escapeHTML(file.root), path = escapeHTML(file.path);
  return `<span class="recency${pill ? ' recency-pill' : ''}" role="img" data-recency-root="${root}" data-recency-path="${path}" data-level="${value.level}" aria-label="${value.label}" title="${value.label}"><span class="recency-dot" aria-hidden="true"></span><span class="recency-label" aria-hidden="true">${pill || value.level === 'hot' ? escapeHTML(value.label) : ''}</span></span>`;
}
export function probeTheme(style) {
  return Object.fromEntries(['--background', '--foreground', '--accent'].map(name => [name, style.getPropertyValue(name).trim()]));
}

// The backend is the only authority for document targets. Match its literal
// occurrences on their source lines; unmatched prose never invents an edge.
export function createRenderer(markdownit, highlight) {
  const md = markdownit({html: false, linkify: false});
  const highlightPart = (text, lang) => {
    const language = lang === 'mermaid' && !highlight?.getLanguage(lang) ? 'plaintext' : lang;
    return language && highlight?.getLanguage(language)
      ? highlight.highlight(text, {language, ignoreIllegals: true}).value : escapeHTML(text);
  };
  function code(text, line, env, lang) {
    return text.split('\n').map((part, offset) => {
      let cursor = 0, result = '';
      const refs = (env.references || []).filter(r => r.style === 'path' && r.line === line + offset);
      while (cursor < part.length) {
        const matches = refs.map(ref => ({ref, at: part.indexOf(ref.text, cursor)})).filter(item => item.at >= 0).sort((a, b) => a.at - b.at);
        if (!matches.length) break;
        const {ref, at} = matches[0];
        result += highlightPart(part.slice(cursor, at), lang) + referenceHTML(ref);
        cursor = at + ref.text.length;
      }
      return result + highlightPart(part.slice(cursor), lang);
    }).join('\n');
  }
  md.core.ruler.at('inline', state => {
    for (const token of state.tokens) {
      if (token.type !== 'inline') continue;
      state.env.line = (token.map?.[0] || 0) + 1;
      state.md.inline.parse(token.content, state.md, state.env, token.children);
    }
  });
  md.inline.ruler.before('text', 'atlas_reference', (state, silent) => {
    if (state.linkLevel) return false;
    const line = state.env.line + state.src.slice(0, state.pos).split('\n').length - 1;
    const ref = (state.env.references || []).find(r => r.line === line && r.style !== 'impact' && state.src.startsWith(r.text, state.pos));
    if (!ref) return false;
    if (!silent) {
      const token = state.push('html_inline', '', 0);
      const label = ref.style === 'markdown' ? /^\[([^]*)\]\(/.exec(ref.text)?.[1] : ref.style === 'wikilink' ? ref.text.slice(2, -2).split('|').pop() : ref.text;
      token.content = referenceHTML(ref, label || ref.text);
    }
    state.pos += ref.text.length;
    return true;
  });
  // Markdown-it's text scanner otherwise swallows bare path/wiki starts.
  md.inline.ruler.before('text', 'atlas_text', (state, silent) => {
    const remaining = state.src.slice(state.pos);
    const candidates = (state.env.references || []).map(r => remaining.indexOf(r.text)).filter(n => n > 0);
    if (!candidates.length) return false;
    const stop = Math.min(...candidates);
    const special = remaining.search(/[\n\\`*_[\]!<&~]/);
    if (special >= 0 && special < stop) return false;
    if (!silent) state.pending += remaining.slice(0, stop);
    state.pos += stop;
    return true;
  });
  md.inline.ruler.before('backticks', 'atlas_code', (state, silent) => {
    const match = /^(`+)([^]*?)\1(?!`)/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push('html_inline', '', 0);
      const line = state.env.line + state.src.slice(0, state.pos).split('\n').length - 1;
      token.content = `<code>${code(match[2], line, state.env)}</code>`;
    }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.fence = (tokens, idx, options, env) => {
    const token = tokens[idx], language = token.info.trim().split(/\s+/)[0];
    const source = `<pre><code>${code(token.content, token.map[0] + 2, env, language)}</code></pre>`;
    return language === 'mermaid' ? `<div class="mermaid-source"><p>Mermaid diagram, shown as source</p>${source}</div>` : source;
  };
  md.core.ruler.after('inline', 'atlas_structure', state => {
    const slugs = new Map();
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type === 'heading_open') {
        const inline = state.tokens[i + 1];
        const title = inline.children.map(t => t.content).join('').replace(/<[^>]*>/g, '');
        const base = title.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
        const count = slugs.get(base) || 0; slugs.set(base, count + 1);
        const id = base + (count ? '-' + count : ''); token.attrSet('id', id);
        state.env.headings.push({id, title, level: Number(token.tag.slice(1))});
      }
      if (token.type === 'inline' && state.tokens[i - 1]?.type === 'paragraph_open' && state.tokens[i - 2]?.type === 'list_item_open') {
        const first = token.children[0];
        const task = first?.type === 'text' && /^\[([ xX])\] /.exec(first.content);
        if (task) {
          first.content = first.content.slice(4);
          const checkbox = new state.Token('html_inline', '', 0);
          checkbox.content = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'} aria-label="Task"> `;
          token.children.unshift(checkbox);
        }
      }
    }
  });
  const defaultLink = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx], href = token.attrGet('href') || '';
    token.attrSet('href', assetURL(env.target, href));
    if (/^https?:/i.test(href)) { token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener noreferrer'); }
    return defaultLink(tokens, idx, options, env, self);
  };
  md.renderer.rules.image = (tokens, idx, options, env) => {
    const token = tokens[idx], src = assetURL(env.target, token.attrGet('src') || '');
    // Local documents cannot silently load remote tracking images.
    return src.startsWith('/raw/') ? `<img src="${escapeHTML(src)}" alt="${escapeHTML(token.content)}">` : escapeHTML(token.content);
  };
  return (content, target, references = []) => {
    const env = {target, references, headings: []};
    let html;
    if (/\.(mmd|mermaid)$/i.test(target.path)) {
      html = `<div class="mermaid-source"><p>Mermaid diagram, shown as source</p><pre><code>${highlightPart(content, 'mermaid')}</code></pre></div>`;
    } else if (/\.md$/i.test(target.path)) html = md.render(content, env);
    else {
      const language = textLanguage(target.path);
      html = `<pre><code class="language-${language}">${highlightPart(content, language)}</code></pre>`;
    }
    return {html, headings: env.headings};
  };
}

export function textLanguage(path) {
  const name = path.split('/').pop().toLowerCase();
  const extension = name === '.env' ? 'env' : name.includes('.') ? name.split('.').pop() : '';
  return ({env:'bash', sh:'bash', py:'python', toml:'toml', json:'json', yml:'yaml', yaml:'yaml', txt:'plaintext'})[extension] || 'plaintext';
}

export function renderFile(data, target, render) {
  return data.binary
    ? {html:`<pre><code>${escapeHTML(`Binary file · ${data.bytes} bytes`)}</code></pre>`, headings:[]}
    : render(data.content, target, data.references.outbound);
}

export async function replaceTheme(document, afterLoad) {
  const old = document.getElementById('theme');
  const next = document.createElement('link');
  next.rel = 'stylesheet'; next.href = `/theme.css?refresh=${Date.now()}`;
  await new Promise((resolve, reject) => {
    next.onload = resolve;
    next.onerror = () => { next.remove(); reject(Error('Theme unavailable; retaining previous theme')); };
    old.after(next);
  });
  old.remove(); next.id = 'theme';
  await afterLoad();
}

export function matchingFiles(files, scope, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return files.filter(file => (!scope || file.root === scope) && (!needle || `${file.path}\n${file.title}`.toLocaleLowerCase().includes(needle)))
    .slice().sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
}

export function adjacentFile(files, target, offset) {
  const at = files.findIndex(file => sameTarget(file, target));
  return at < 0 ? null : files[at + offset] || null;
}
const HISTORY_HIGH_WATER = 'atlas-history-high-water';
export function historyHighWater(storage, current, reset = false) {
  let high = current;
  try {
    const stored = Number(storage.getItem(HISTORY_HIGH_WATER));
    if (!reset && Number.isInteger(stored) && stored >= current) high = stored;
    storage.setItem(HISTORY_HIGH_WATER, String(high));
  } catch { /* History still works when session storage is unavailable. */ }
  return high;
}

export function isTextEntry(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

export function shortcutFor(event, view) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  if (event.editable) return event.key === 'Escape' ? 'escape' : null;
  if (event.key === 'Escape') return 'escape';
  if (['Backspace', 'h', 'ArrowLeft'].includes(event.key)) return 'back';
  if (['l', 'ArrowRight'].includes(event.key)) return 'activate';
  if (event.key === '/') return 'search';
  if (event.key === 'o') return 'files';
  if (event.key === 'r') return 'refresh';
  if (event.key === 'z') return 'toolbar';
  if (view === 'read') return ({m:'map', n:'neighbourhood', d:'details', e:'edit', t:'outline', b:'backlinks', j:'down', k:'up'}[event.key] || null);
  return ({d:'details', e:'edit', m:'map', n:'neighbourhood', j:'next', k:'previous', ArrowDown:'next', ArrowUp:'previous'}[event.key] || null);
}

export async function startApp() {
  const $ = id => document.getElementById(id);
  const initialHistoryState = history.state;
  let route = parseRoute(location.href), index = null, selected = route.target;
  let coldTargetPending = route.view === 'map' && !!route.target && !(initialHistoryState?.map && 'selected' in initialHistoryState.map);
  let map = null, scope = initialHistoryState?.map?.scope || null, mapModule = null, mapLoading = null;
  let mapIndex = null, mapScope = null;
  let generation = 0, factsGeneration = 0, visitIndex = initialHistoryState?.atlasIndex || 0;
  let maxVisitIndex = historyHighWater(sessionStorage, visitIndex, !initialHistoryState?.atlas);
  let capturedFiles = [], pickerScope = null, overlay = null, overlayOpener = null;
  let themeQueue = Promise.resolve(), shown = null, indexFailure = null;
  const libraryLoads = new Map();
  function loadLibrary(name) {
    if (!libraryLoads.has(name)) libraryLoads.set(name, new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = `/vendor/${name}.min.js`;
      script.onload = resolve; script.onerror = () => { libraryLoads.delete(name); script.remove(); reject(Error(`${name} unavailable`)); };
      document.head.append(script);
    }));
    return libraryLoads.get(name);
  }
  const toolbarKey = 'atlas-toolbar-hidden';
  let toolbarHidden = false;
  try { toolbarHidden = localStorage.getItem(toolbarKey) === 'true'; } catch { /* The toggle still works without storage. */ }
  function setToolbarHidden(hidden, moveFocus = false) {
    toolbarHidden = hidden;
    $('toolbar').hidden = hidden; $('show-toolbar').hidden = !hidden;
    document.body.classList.toggle('toolbar-hidden', hidden);
    $('hide-toolbar').setAttribute('aria-expanded', String(!hidden));
    $('show-toolbar').setAttribute('aria-expanded', String(!hidden));
    if (moveFocus) (hidden ? $('show-toolbar') : $('hide-toolbar')).focus();
    try { localStorage.setItem(toolbarKey, String(hidden)); } catch { /* In-memory state remains usable. */ }
  }
  setToolbarHidden(toolbarHidden);
  const render = createRenderer(window.markdownit, window.hljs);
  const blankProbe = {zoom:null, pins:[], counts:{nodes:0, edges:0}, cooled:false, settleMs:null};
  window.atlasProbe = {get view() { return route.view; }, get target() { return selected && {...selected}; }, theme() { return probeTheme(getComputedStyle(document.documentElement)); }, get map() { return map?.probe?.() || blankProbe; }};
  const message = (text = '', retry = false) => { $('status').textContent = text; $('retry').hidden = !retry; };
  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) { const body = await response.json().catch(() => ({})); const error = Error(body.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
    return response.json();
  }
  const position = () => ({x:$('reading').scrollLeft, y:$('reading').scrollTop});
  function restore(saved) { if (saved) $('reading').scrollTo(saved.x, saved.y); else if (route.anchor) document.getElementById(route.anchor)?.scrollIntoView(); else $('reading').scrollTo(0, 0); }
  function visitState() {
    return {atlas:true, atlasIndex:visitIndex, route:{view:route.view, target:route.target, anchor:route.anchor || ''}, read:{scroll:position()}, map:map ? {...map.getView(), scope} : null};
  }
  function saveVisit() { history.replaceState(visitState(), '', location.href); }
  function historyButtons() { $('back-button').disabled = visitIndex <= 0; $('forward-button').disabled = visitIndex >= maxVisitIndex; }
  function closeOverlay(focus = true) {
    if (!overlay) return false;
    $(overlay).hidden = true; overlay = null;
    if (focus) overlayOpener?.focus?.();
    overlayOpener = null; return true;
  }
  function openOverlay(id, opener) { closeOverlay(false); overlay = id; overlayOpener = opener || document.activeElement; $(id).hidden = false; $(id).focus(); }
  function breadcrumb() {
    if (route.view === 'map') $('crumb-tail').innerHTML = scope ? '<span class="crumb-separator">›</span><span aria-current="page">Neighbourhood</span>' : '<span class="crumb-separator">›</span><span aria-current="page">Whole map</span>';
    else if (route.target) $('crumb-tail').innerHTML = `<span class="crumb-separator">›</span><button data-root="${escapeHTML(route.target.root)}">${escapeHTML(route.target.root)}</button><span class="crumb-separator">›</span><span aria-current="page">${escapeHTML(route.target.path)}</span>`;
    else $('crumb-tail').textContent = '';
  }
  function updateChrome() {
    breadcrumb(); historyButtons();
    $('files-button').classList.toggle('active', overlay === 'picker');
    $('neighbourhood-button').setAttribute('aria-pressed', String(route.view === 'map' && !!scope));
    $('neighbourhood-button').classList.toggle('active', route.view === 'map' && !!scope);
    $('map-button').classList.toggle('active', route.view === 'map' && !scope);
    for (const [id, current] of [['map-button', route.view === 'map' && !scope], ['neighbourhood-button', route.view === 'map' && !!scope]]) {
      if (current) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
    }
    $('neighbourhood-button').disabled = !route.target;
    const previous = adjacentFile(capturedFiles, route.target, -1), next = adjacentFile(capturedFiles, route.target, 1);
    $('previous-file').disabled = !previous; $('next-file').disabled = !next;
    $('previous-file').hidden = !previous; $('next-file').hidden = !next;
  }
  function referenceList(refs, direction) {
    return refs.map(ref => `<li><span>line ${ref.line}</span> ${direction === 'inbound' ? `${recencyHTML(fileFor(ref.from))} <a href="${escapeHTML(routeURL('read', ref.from))}">${escapeHTML(ref.from.root + '/' + ref.from.path)}</a> — ${escapeHTML(ref.text)}` : referenceHTML(ref)}</li>`).join('');
  }
  function fileFor(target) { return (sameTarget(currentFile, target) ? currentFile : null) || (index?.files || []).find(file => sameTarget(file, target)); }
  let currentFile = null;
  function updateRecency() {
    for (const node of document.querySelectorAll('[data-recency-root]')) {
      const value = recency(fileFor({root:node.dataset.recencyRoot, path:node.dataset.recencyPath}));
      if (!value) { node.remove(); continue; }
      node.dataset.level = value.level; node.setAttribute('aria-label', value.label); node.title = value.label;
      const label = node.querySelector('.recency-label'); if (label) label.textContent = node.classList.contains('recency-pill') || value.level === 'hot' ? value.label : '';
    }
  }
  function groupedReferences(refs, direction) {
    const groups = refs.reduce((groups, ref) => groups.set(ref.style, [...(groups.get(ref.style) || []), ref]), new Map());
    return [...groups].map(([style, entries]) => `<h4>${escapeHTML(style)}</h4><ul>${referenceList(entries, direction)}</ul>`).join('') || '<p>No references.</p>';
  }
  function factsHTML(data) {
    const f = data.file;
    return `<h2>${escapeHTML(f.title)}</h2><p>${escapeHTML(f.root + '/' + f.path)}</p><p>${escapeHTML(f.kind)} · ${escapeHTML(f.time)} (${escapeHTML(f.timeSource)})</p><p>${f.inbound} inbound · ${f.outbound} outbound${f.orphan ? ' · orphan' : ''} · ${f.dangling} dangling</p>${f.stale ? `<p class="stale">Stale: ${escapeHTML(f.stale.newestSource.path)} is newer (${escapeHTML(f.stale.newestSource.time)}), ${escapeHTML(f.stale.rule)}</p>` : ''}${(data.cost || []).map(row => `<p>${escapeHTML(row.agent)} · ~${row.startupTokensApprox} tokens at startup · ~${row.referencedTokensApprox} referenced</p>`).join('')}`;
  }
  function metadataHTML(data) {
    const f = data.file;
    return `<p>${escapeHTML(f.kind)} · ${escapeHTML(f.time)} (${escapeHTML(f.timeSource)}) · ${f.inbound} inbound · ${f.outbound} outbound${f.orphan ? ' · orphan' : ''}${f.dangling ? ` · ${f.dangling} dangling` : ''}${f.stale ? ' · stale' : ''}</p>${recencyHTML(f, true)}`;
  }
  function actionRow(view) {
    return `<div class="actions">${view === 'read' ? '' : '<button data-action="read" aria-keyshortcuts="Enter">Read <span aria-hidden="true">↵</span></button>'}${view === 'map' ? '' : '<button data-action="map" aria-keyshortcuts="m">Map <span aria-hidden="true">m</span></button>'}<button data-action="edit" aria-keyshortcuts="e">Edit <span aria-hidden="true">e</span></button><button data-action="details" aria-keyshortcuts="d">Details <span aria-hidden="true">d</span></button></div>`;
  }
  async function showFacts(target, opener) {
    if (!target) return; selected = target; openOverlay('facts', opener);
    const ticket = ++factsGeneration; $('facts').textContent = 'Loading details…';
    try {
      const data = await request(fileURL(target)); if (ticket !== factsGeneration) return;
      $('facts').innerHTML = '<div class="pane-heading"><h2>Details</h2><button data-action="close-details">Close</button></div>' + factsHTML(data) + actionRow(route.view) + '<button data-action="copy">Copy path</button>' + ['inbound','outbound'].map(direction => `<h3>${direction}</h3>${groupedReferences(data.references[direction], direction)}`).join('');
    } catch (error) { if (ticket === factsGeneration) $('facts').textContent = error.message; }
  }
  function toggleFacts(target, opener) {
    if (!target) return;
    if (overlay === 'facts' && sameTarget(selected, target)) { closeOverlay(); updateChrome(); }
    else showFacts(target, opener);
  }
  async function edit(target = selected || route.target) {
    if (!target) return;
    try { await request('/api/edit', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(target)}); } catch (error) { message(error.message, true); }
  }
  async function copyPath(target = selected || route.target) {
    if (!target) return;
    try { await navigator.clipboard.writeText(`${target.root}/${target.path}`); message('Path copied'); } catch (error) { message(`Copy unavailable: ${error.message}`); }
  }
  function renderNeighbours(data) {
    const entries = [...data.references.inbound.map(ref => ({target:ref.from, label:`${ref.from.root}/${ref.from.path}`, detail:`inbound · ${ref.style} · line ${ref.line}`})), ...data.references.outbound.map(ref => ({target:ref.resolved ? ref.to : null, label:ref.resolved ? `${ref.to.root}/${ref.to.path}` : ref.text, detail:`outbound · ${ref.style} · line ${ref.line}${ref.resolved ? '' : ' · missing'}`}))];
    $('neighbour-list').innerHTML = entries.length ? entries.map((entry, i) => `<div class="neighbour-row" role="option" tabindex="0" data-neighbour="${i}" aria-selected="false">${entry.target ? recencyHTML(fileFor(entry.target)) : ''} <strong>${escapeHTML(entry.label)}</strong><small>${escapeHTML(entry.detail)}</small></div>`).join('') : '<p>No direct references.</p>';
    $('neighbour-list')._entries = entries;
  }
  async function loadRead(saved = null) {
    const ticket = ++generation, target = route.target;
    if (!target) { shown = null; $('document-title').textContent = ''; $('document').textContent = ''; $('metadata').textContent = ''; $('backlinks').textContent = ''; return; }
    // A live reload of the open file keeps it on screen until the new content arrives.
    if (!sameTarget(shown, target)) {
      $('document-title').textContent = '';
      $('document').textContent = 'Loading file…';
      $('metadata').textContent = '';
      $('backlinks').textContent = '';
    }
    try {
      const data = await request(fileURL(target)); if (ticket !== generation) return;
      shown = target; currentFile = data.file;
      sessionStorage.setItem('atlas-last-target', JSON.stringify(target));
      const result = renderFile(data, target, render);
      $('document-title').textContent = data.file.title;
      $('document').innerHTML = result.html;
      if (result.headings[0]?.level === 1) { $('document').querySelector('h1')?.remove(); result.headings[0].id = 'document-title'; }
      $('metadata').innerHTML = metadataHTML(data);
      $('toc').innerHTML = result.headings.map(h => `<a href="#${encodeURIComponent(h.id)}" style="padding-inline-start:${h.level - 1}ch">${escapeHTML(h.title)}</a>`).join('');
      const roots = [...new Set(data.references.inbound.map(ref => ref.from.root))];
      $('backlinks').innerHTML = '<h2>Backlinks</h2>' + (roots.length ? roots.map(root => `<h3>${escapeHTML(root)}</h3><ul>${referenceList(data.references.inbound.filter(ref => ref.from.root === root), 'inbound')}</ul>`).join('') : '<p>No inbound references.</p>');
      const unavailable = (index?.unavailable || []).filter(item => item.root === target.root && (!item.path || item.path === target.path));
      if (unavailable.length) $('metadata').insertAdjacentHTML('beforeend', `<p>Stale analysis unavailable: ${unavailable.map(item => escapeHTML(item.reason)).join('; ')}</p>`);
      renderNeighbours(data); message(indexFailure ? `${indexFailure} · Retaining index from ${index?.generatedAt || 'last successful refresh'}` : '', !!indexFailure); restore(saved);
    } catch (error) {
      if (ticket !== generation) return;
      shown = null; $('document-title').textContent = error.status === 404 ? 'File missing' : error.status === 413 ? 'File too large' : 'File unavailable'; $('metadata').innerHTML = `<p>${escapeHTML(target.root + '/' + target.path)}</p>`; $('document').textContent = error.status === 404 ? 'The file could not be found.' : error.status === 413 ? 'This file exceeds the 2 MB reader limit.' : 'The server could not load this file.'; $('backlinks').textContent = ''; message(error.message, true);
    }
  }
  async function loadMapModule() {
    if (mapModule) return mapModule;
    if (!mapLoading) mapLoading = loadLibrary('force-graph').then(() => import('./map.js')).then(module => {
      if (!document.querySelector('link[data-map]')) { const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/map.css'; css.dataset.map = ''; document.head.append(css); }
      return (mapModule = module);
    });
    return mapLoading;
  }
  async function showMap(savedView = null, preferTarget = false) {
    try {
      const module = await loadMapModule();
      if (!map) map = module.createMap($('map-view'), {onSelect:target => { selected = target; selectNeighbour(target); }, onDetails:target => toggleFacts(target, $('map-view')), onRead:target => navigate('read', target), onEdit:edit,
        onViewChange:() => { if (route.view === 'map') saveVisit(); }});
      if (index && mapIndex !== index) { map.setIndex(index); mapIndex = index; }
      if ((scope || mapScope) && !sameTarget(mapScope, scope)) { map.setScope(scope); mapScope = scope; }
      if (savedView && 'selected' in savedView && !preferTarget && map.setView) map.setView(savedView); else if (route.target) map.setTarget(route.target);
      map.setVisible(route.view === 'map');
    } catch (error) { mapLoading = null; $('map-view').textContent = `Map unavailable: ${error.message}. Read remains available.`; }
  }
  function selectNeighbour(target) {
    for (const row of $('neighbour-list').querySelectorAll('[data-neighbour]')) {
      row.setAttribute('aria-selected', String(sameTarget($('neighbour-list')._entries?.[Number(row.dataset.neighbour)]?.target, target)));
    }
  }
  async function loadNeighbours() {
    const target = scope;
    if (!target) return;
    $('neighbour-list').textContent = 'Loading references…';
    try {
      const data = await request(fileURL(target));
      if (sameTarget(scope, target)) { renderNeighbours(data); selectNeighbour(selected); }
    } catch (error) { if (sameTarget(scope, target)) $('neighbour-list').textContent = error.message; }
  }
  function openNeighbourhood() {
    if (scope) return openWholeMap();
    if (route.target) return navigate('map', route.target, '', 'push', {map:{scope:route.target}});
  }
  function renderPicker() {
    const files = matchingFiles(index?.files || [], pickerScope, $('file-search').value);
    $('file-list')._files = files;
    $('file-list').innerHTML = files.length ? files.map((file, i) => `<button class="file-row" role="option" data-file="${i}">${recencyHTML(file)} ${escapeHTML(file.root + '/' + file.path)}<small>${escapeHTML(file.title)} · ${escapeHTML(file.kind)}</small></button>`).join('') : `<p>${index?.roots.length ? 'No matching files.' : 'No roots registered. Add one with atlas root-add PATH.'}</p>`;
  }
  function openPicker(scope = null, opener) { pickerScope = scope; $('picker-title').textContent = scope ? `Files · ${scope}` : 'Files'; $('file-search').value = ''; renderPicker(); openOverlay('picker', opener); $('file-search').focus(); updateChrome(); }
  async function display(state = null) {
    scope = route.view === 'map' ? state?.map?.scope || null : null;
    const restoredSelection = state?.map?.selected;
    selected = route.view === 'map' && typeof restoredSelection?.root === 'string' && typeof restoredSelection?.path === 'string' ? restoredSelection : route.target; closeOverlay(false);
    $('read-view').hidden = route.view !== 'read'; $('map-view').hidden = route.view !== 'map';
    $('neighbourhood').hidden = !scope;
    $('map-view').setAttribute('aria-label', scope ? 'Neighbourhood' : 'Whole map');
    map?.setVisible(route.view === 'map'); if (route.view === 'map') { ++generation; await showMap(state?.map); await loadNeighbours(); }
    else await loadRead(state?.read?.scroll || null);
    updateChrome();
  }
  async function navigate(view, target = route.target, anchor = '', mode = 'push', state = null) {
    if (sameTarget(route.target, target) && route.view === view && ((!scope && !state?.map?.scope) || sameTarget(scope, state?.map?.scope)) && !anchor && mode === 'push') { if (view === 'map' && target) map?.setTarget(target); closeOverlay(); return; }
    if (mode === 'push') { saveVisit(); visitIndex += 1; maxVisitIndex = historyHighWater(sessionStorage, visitIndex, true); }
    route = {view, target, anchor}; selected = target;
    const nextState = {atlas:true, atlasIndex:visitIndex, route:{...route}, read:{scroll:null}, map:null, ...state};
    if (mode === 'push') history.pushState(nextState, '', routeURL(view, target, anchor));
    else if (mode === 'replace') history.replaceState(nextState, '', routeURL(view, target, anchor));
    await display(nextState); saveVisit();
  }
  async function refresh() {
    const saved = visitState();
    try {
      index = await request('/api/index'); indexFailure = null;
      if (map) { map.setIndex(index); mapIndex = index; }
      if (!route.target && route.view === 'read') {
        let last = null; try { last = JSON.parse(sessionStorage.getItem('atlas-last-target')); } catch { /* fresh session */ }
        if (last && index.files.some(file => sameTarget(file, last))) await navigate('read', last, '', 'replace');
        else { await loadRead(); openPicker(null, $('files-button')); message(index.roots.length ? (index.files.length ? '' : 'Registered roots contain no documents.') : 'No roots registered. Add a root with atlas root-add.'); }
      } else if (route.view === 'read') await loadRead(saved.read.scroll);
      else { await showMap(saved.map, coldTargetPending); if (map) coldTargetPending = false; await loadNeighbours(); }
    } catch (error) { indexFailure = error.message; message(`${error.message}${index ? ` · Retaining index from ${index.generatedAt}` : ''}`, true); }
    updateChrome();
  }
  history.replaceState(initialHistoryState?.atlas ? initialHistoryState : {atlas:true, atlasIndex:visitIndex, route:{...route}, read:{scroll:null}, map:null}, '', location.href);
  $('back-button').onclick = () => { if (closeOverlay()) updateChrome(); else history.back(); };
  $('forward-button').onclick = () => history.forward();
  $('hide-toolbar').onclick = () => setToolbarHidden(true, true);
  $('show-toolbar').onclick = () => setToolbarHidden(false, true);
  $('atlas-button').onclick = event => openPicker(null, event.currentTarget);
  $('files-button').onclick = event => openPicker(null, event.currentTarget);
  const openWholeMap = () => navigate('map', !$('neighbourhood').hidden && selected ? selected : route.target);
  $('map-button').onclick = openWholeMap;
  $('neighbourhood-button').onclick = openNeighbourhood;
  $('previous-file').onclick = () => { const file = adjacentFile(capturedFiles, route.target, -1); if (file) navigate('read', file); };
  $('next-file').onclick = () => { const file = adjacentFile(capturedFiles, route.target, 1); if (file) navigate('read', file); };
  $('retry').onclick = () => { refresh(); if ($('theme-status').textContent) reloadTheme(); };
  $('file-search').oninput = renderPicker;
  $('file-list').onclick = event => { const row = event.target.closest('[data-file]'); if (!row) return; capturedFiles = $('file-list')._files.slice(); navigate('read', capturedFiles[Number(row.dataset.file)]); };
  $('crumb-tail').onclick = event => { const root = event.target.dataset.root; if (root) openPicker(root, event.target); };
  $('reader-actions').onclick = event => { const action = event.target.closest('[data-action]'); if (action) runAction(action.dataset.action, route.target, action); };
  $('facts').onclick = event => { const action = event.target.closest('[data-action]'); if (action) runAction(action.dataset.action, selected, action); };
  $('neighbourhood').onclick = event => {
    if (event.target.dataset.action === 'close-neighbourhood') return history.back();
    const row = event.target.closest('[data-neighbour]'); if (!row) return;
    const entry = $('neighbour-list')._entries[Number(row.dataset.neighbour)]; selected = entry.target; if (selected) map?.setTarget(selected);
    for (const item of $('neighbour-list').querySelectorAll('[data-neighbour]')) item.setAttribute('aria-selected', String(item === row));
    if (entry.target) showFacts(entry.target, row);
  };
  async function runAction(action, target, opener) {
    if (!action) return;
    if (action === 'close-picker' || action === 'close-details') { closeOverlay(); updateChrome(); }
    else if (action === 'read' && target) navigate('read', target);
    else if (action === 'map' && target) navigate('map', target);
    else if (action === 'edit') edit(target);
    else if (action === 'details') toggleFacts(target, opener);
    else if (action === 'copy') copyPath(target);
  }
  document.addEventListener('click', event => {
    const action = event.target.dataset.action;
    if (action === 'close-picker') { closeOverlay(); updateChrome(); return; }
    const link = event.target.closest('a'); if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const url = new URL(link.href, location.href); if (url.origin !== location.origin || !/^\/(read|map)(\/|$)/.test(url.pathname)) return;
    event.preventDefault(); const next = parseRoute(url.href); if (link.dataset.missing) showFacts(next.target, link); else navigate(next.view, next.target, next.anchor);
  });
  $('search-form').onsubmit = event => {
    event.preventDefault(); const query = $('search').value.toLocaleLowerCase(), walker = document.createTreeWalker($('document'), NodeFilter.SHOW_TEXT); let node;
    while (query && (node = walker.nextNode())) { const at = node.textContent.toLocaleLowerCase().indexOf(query); if (at < 0) continue; const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + query.length); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); node.parentElement.scrollIntoView({block:'center'}); return; }
    message('No matching text in this document.');
  };
  document.addEventListener('keydown', event => {
    const nativeControl = event.target.closest('button, a, summary');
    const pickerRow = overlay === 'picker' ? event.target.closest('[data-file]') : null;
    if (pickerRow && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      const rows = [...$('file-list').querySelectorAll('[data-file]')];
      const next = rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(pickerRow) + (event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { event.preventDefault(); event.stopImmediatePropagation(); next.focus(); }
      return;
    }
    const neighbourRow = event.target.closest('[data-neighbour]');
    const neighbourTarget = event.key === 'Enter' ? ($('neighbour-list')._entries || [])[Number(neighbourRow?.dataset.neighbour)]?.target || null : null;
    if (neighbourTarget && !nativeControl && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      event.preventDefault(); event.stopImmediatePropagation(); navigate('read', neighbourTarget); return;
    }
    const editable = isTextEntry(event.target);
    const action = shortcutFor({key:event.key, ctrlKey:event.ctrlKey, metaKey:event.metaKey, altKey:event.altKey, isComposing:event.isComposing, editable}, route.view);
    if (!action) return;
    if (action === 'escape') {
      if (editable && event.target.value) { event.target.value = ''; event.target.dispatchEvent(new Event('input')); event.preventDefault(); return; }
      if (closeOverlay()) { event.preventDefault(); event.stopImmediatePropagation(); updateChrome(); return; }
      if (scope) { history.back(); event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (route.view === 'map' && selected) { selected = null; event.preventDefault(); return; }
      (route.view === 'read' ? $('reading') : $('map-view')).focus(); return;
    }
    const moveMap = offset => { if (scope) {
      const entries = $('neighbour-list')._entries || [];
      const targets = entries.filter(entry => entry.target).map(entry => entry.target);
      const next = adjacentFile(targets, selected, offset) || targets[offset > 0 ? 0 : targets.length - 1];
      if (next) { selected = next; map?.setTarget(next); selectNeighbour(next); }
      return;
    } const files = matchingFiles(index?.files || [], null); const next = adjacentFile(files, selected || route.target, offset) || files[offset > 0 ? 0 : files.length - 1]; if (next) { selected = next; map?.setTarget(next); } };
    const handlers = {back:() => closeOverlay() || history.back(), activate:() => route.view === 'map' && selected ? navigate('read', selected) : document.activeElement?.click?.(), search:() => overlay === 'picker' ? $('file-search').focus() : route.view === 'read' ? $('search').focus() : map?.focusSearch(), files:() => openPicker(null, $('files-button')), refresh, toolbar:() => setToolbarHidden(!toolbarHidden), map:openWholeMap, neighbourhood:openNeighbourhood, details:() => toggleFacts(selected || route.target, document.activeElement), edit:() => edit(selected || route.target), outline:() => ($('toc').querySelector('a') || $('toc')).focus(), backlinks:() => { $('backlinks').focus(); $('backlinks').scrollIntoView(); }, down:() => $('reading').scrollBy(0, 80), up:() => $('reading').scrollBy(0, -80), next:() => moveMap(1), previous:() => moveMap(-1), target:() => route.target && map?.setTarget(route.target)};
    if (handlers[action]) { event.preventDefault(); event.stopImmediatePropagation(); handlers[action](); }
  });
  window.addEventListener('popstate', async event => {
    const state = event.state?.atlas ? event.state : null; route = state?.route || parseRoute(location.href); visitIndex = state?.atlasIndex ?? visitIndex; await display(state); historyButtons();
  });
  const events = new EventSource('/api/events');
  events.addEventListener('open', refresh);
  events.addEventListener('error', () => message('Server disconnected; reconnecting. Previous results retained.', true));
  events.addEventListener('index', refresh);
  events.addEventListener('index-error', event => { const failure = JSON.parse(event.data); indexFailure = failure.error; message(`${failure.error} · Retaining index from ${failure.generatedAt || 'last successful refresh'}`, true); });
  events.addEventListener('file', event => { const target = JSON.parse(event.data); if (route.view === 'read' && sameTarget(target, route.target)) loadRead(position()); });
  events.addEventListener('show', event => { const next = JSON.parse(event.data); navigate(next.view, {root:next.root, path:next.path}); });
  function reloadTheme() { themeQueue = themeQueue.catch(() => {}).then(() => replaceTheme(document, () => { map?.setTheme(); $('theme-status').textContent = ''; })).catch(error => { $('theme-status').textContent = error.message; $('retry').hidden = false; }); }
  events.addEventListener('theme', reloadTheme);
  const recencyTimer = setInterval(updateRecency, 30000);
  window.addEventListener('pagehide', () => { clearInterval(recencyTimer); events.close(); map?.destroy(); }, {once:true});
  await display(history.state); await refresh();
}
if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => startApp().catch(error => { document.getElementById('status').textContent = `Reader unavailable: ${error.message}`; }));
