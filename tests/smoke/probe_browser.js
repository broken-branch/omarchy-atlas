#!/usr/bin/env node
/*
 * Read-only Chromium CDP probe. Launch the reader first:
 * omarchy-launch-or-focus-webapp 'Atlas Reader' http://127.0.0.1:4137/ --remote-debugging-port=9222
 * before invoking this script. It needs Node 24's built-in WebSocket only.
 */
'use strict';

const CDP_URL = process.env.ATLAS_CDP || 'http://127.0.0.1:9222';
const PAGE_PREFIX = 'http://127.0.0.1:4137/';

function selectTarget(targets, prefix = PAGE_PREFIX) {
  return targets.find(target => target.type === 'page' && typeof target.url === 'string' && target.url.startsWith(prefix)) || null;
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * fraction, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}
function aggregate(values) {
  return {median: percentile(values, .5), p95: percentile(values, .95), worst: values.length ? Math.max(...values) : null};
}
function sameSelection(a, b) {
  if (a === null || b === null) return a === b;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.hasOwn(a, 'id') || Object.hasOwn(b, 'id')) return typeof a.id === 'string' && typeof b.id === 'string' && a.id === b.id;
  return typeof a.root === 'string' && typeof a.path === 'string' && typeof b.root === 'string' && typeof b.path === 'string'
    && a.root === b.root && a.path === b.path;
}
function sameMapView(a, b) {
  return !!a && !!b && Number.isFinite(a.zoom) && Number.isFinite(b.zoom)
    && Number.isFinite(a.center?.x) && Number.isFinite(a.center?.y) && Number.isFinite(b.center?.x) && Number.isFinite(b.center?.y)
    && a.zoom === b.zoom && a.center.x === b.center.x && a.center.y === b.center.y
    && sameSelection(a.selected, b.selected);
}
function diagramState(root = document, computedStyle = getComputedStyle) {
  const diagrams = [...root.querySelectorAll('.diagram')];
  const sample = root.querySelector('.diagram svg path') || root.querySelector('.diagram foreignObject span');
  const style = sample ? computedStyle(sample) : null;
  return {
    diagrams: diagrams.length,
    svgs: root.querySelectorAll('.diagram svg').length,
    color: style?.color || null,
    fill: style?.fill || null,
    unavailable: diagrams.filter(node => node.textContent.trimStart().startsWith('Diagram unavailable')).map(node => node.textContent)
  };
}
class CDPClient {
  constructor(socket) { this.socket = socket; this.nextID = 1; this.pending = new Map(); socket.addEventListener('message', event => this.message(event.data)); }
  message(frame) {
    const message = typeof frame === 'string' ? JSON.parse(frame) : JSON.parse(Buffer.from(frame).toString());
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(Error(message.error.message)); else pending.resolve(message.result);
  }
  command(method, params = {}) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => { this.pending.set(id, {resolve, reject}); this.socket.send(JSON.stringify({id, method, params})); });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result.value;
  }
}
async function targets(base = CDP_URL) { return (await (await fetch(`${base}/json/list`)).json()); }
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true}); });
  return new CDPClient(socket);
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const WORKSPACE_ERROR = 'reader window must be on the active workspace';
function settledMeasurement(map) {
  if (!map?.cooled) {
    if (/paused|hidden/i.test(map?.settleReason || '')) throw Error(WORKSPACE_ERROR);
    return null;
  }
  if (Number.isFinite(map.settleMs)) return map.settleMs;
  throw Error(`Map engine stopped without convergence: ${map.settleReason || 'unknown reason'}`);
}
async function frameSnapshot(client, timeout = 2000) {
  let timer;
  try {
    return await Promise.race([
      client.evaluate(`new Promise(resolve => requestAnimationFrame(() => resolve(window.atlasProbe?.map || null)))`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(WORKSPACE_ERROR)), timeout); })
    ]);
  } finally { clearTimeout(timer); }
}
async function pageClient() {
  const target = selectTarget(await targets());
  if (!target) throw Error(`No page target starts with ${PAGE_PREFIX}`);
  return connect(target);
}
async function state(client) {
  return client.evaluate(`(() => {
    const diagramState = ${diagramState.toString()};
    const style = node => { const value = getComputedStyle(node); return {color:value.color, backgroundColor:value.backgroundColor}; };
    const probe = window.atlasProbe || {};
    return {view:probe.view || null, location:location.href, target:probe.target || null, theme:probe.theme ? probe.theme() : null,
      body:style(document.body), code:(document.querySelector('pre code') ? style(document.querySelector('pre code')) : null),
      mermaid:diagramState(document, getComputedStyle),
      scrollY:document.getElementById('reading')?.scrollTop ?? window.scrollY, map:probe.map || null,
      mapControlsHidden:probe.map?.view?.controlsHidden ?? null};
  })()`);
}
async function key(client, keys) {
  for (const character of keys) {
    const code = character === '/' ? 'Slash' : `Key${character.toUpperCase()}`;
    const windowsVirtualKeyCode = character === '/' ? 191 : character.toUpperCase().charCodeAt(0);
    const keyParams = {key:character, code, windowsVirtualKeyCode};
    await client.command('Input.dispatchKeyEvent', {type:'keyDown', ...keyParams, text:character});
    await client.command('Input.dispatchKeyEvent', {type:'keyUp', ...keyParams});
    await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  const result = await state(client);
  return {...result,
    activeElement: await client.evaluate(`(() => { const node=document.activeElement; return {tag:node?.tagName?.toLowerCase() || null, ariaLabel:node?.getAttribute('aria-label') || null, placeholder:node?.getAttribute('placeholder') || null}; })()`)
  };
}
async function shot(client, file, width = 1600, height = 1000) {
  const metrics = {width:Number(width), height:Number(height), deviceScaleFactor:1, mobile:false};
  await client.command('Emulation.setDeviceMetricsOverride', metrics);
  try {
    const isMap = await client.evaluate("window.atlasProbe?.view === 'map'");
    if (isMap) await waitForSettle(client);
    else await sleep(2000);
    const capture = await client.command('Page.captureScreenshot', {format:'png', fromSurface:true});
    const bytes = Buffer.from(capture.data, 'base64');
    require('fs').writeFileSync(file, bytes);
    return {file, width:metrics.width, height:metrics.height, bytes:bytes.length};
  } finally {
    await client.command('Emulation.clearDeviceMetricsOverride');
  }
}
async function controls(client) {
  return client.evaluate(`(() => {
    const style = node => {
      const value = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const round = number => Math.round(number * 10) / 10;
      return {text:node.textContent.trim(), width:round(rect.width), height:round(rect.height),
        fontSize:value.fontSize, lineHeight:value.lineHeight, paddingTop:value.paddingTop,
        paddingLeft:value.paddingLeft, borderTopWidth:value.borderTopWidth};
    };
    const root = getComputedStyle(document.documentElement);
    const selectors = ['header button', '#previous-file', '#reader-actions button',
      '.map-graph-controls button', '.map-controls button', '.file-row'];
    const result = {root:{fontSize:root.getPropertyValue('--font-size'),
      fontSizeSmall:root.getPropertyValue('--font-size-small'),
      controlHeight:root.getPropertyValue('--control-height'),
      controlPaddingX:root.getPropertyValue('--control-padding-x'),
      controlPaddingY:root.getPropertyValue('--control-padding-y')}};
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) result[selector] = style(node);
    }
    return result;
  })()`);
}
async function waitForSettle(client, timeout = 10000, frameTimeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const map = await client.evaluate('window.atlasProbe?.map || null');
    settledMeasurement(map);
    const frameMeasurement = settledMeasurement(await frameSnapshot(client, frameTimeout));
    if (frameMeasurement !== null) return frameMeasurement;
  }
  throw Error('Map engine did not stop before timeout');
}
async function waitFor(client, expression, description, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await client.evaluate(expression)) return; } catch { /* The document may be between navigations. */ }
    await sleep(50);
  }
  throw Error(`${description} did not become ready before timeout`);
}
async function layouts(client, count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    await client.evaluate(`location.assign('/map?probe-layout=${i}')`);
    await sleep(100);
    values.push(await waitForSettle(client));
  }
  return {settleMs: values, ...aggregate(values)};
}
async function pan(client, seconds) {
  const view = await client.evaluate('window.atlasProbe?.view || null');
  if (view !== 'map') {
    await client.evaluate(`location.assign('/map?probe-pan=${Date.now()}')`);
    await sleep(100);
  }
  await waitForSettle(client);
  const before = await client.evaluate('window.atlasProbe?.map || null');
  const box = await client.evaluate(`(() => {
    const canvas = document.querySelector('#map-view canvas'), point = window.atlasProbe?.map?.panPoint;
    if (!canvas || !point || point.node !== null || document.elementFromPoint(point.x, point.y) !== canvas) return null;
    const r = canvas.getBoundingClientRect(); return {x:point.x,y:point.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width};
  })()`);
  if (!box) throw Error('Map canvas is unavailable');
  await client.evaluate('window.__atlasProbeFrames=[]; window.__atlasProbeRecording=true; (function frame(t){ if(window.__atlasProbeRecording) { window.__atlasProbeFrames.push(t); requestAnimationFrame(frame); } })(performance.now())');
  await client.command('Input.dispatchMouseEvent', {type:'mousePressed', x:box.x, y:box.y, button:'left', clickCount:1});
  const xAmplitude = Math.max(1, Math.min(180, box.width / 3, box.x - box.left - 2, box.right - box.x - 2));
  const yAmplitude = Math.max(1, Math.min(80, box.y - box.top - 2, box.bottom - box.y - 2));
  const until = Date.now() + seconds * 1000; let step = 0, x = box.x, y = box.y;
  while (Date.now() < until) {
    x = box.x + Math.sin(step / 4) * xAmplitude; y = box.y + Math.cos(step / 5) * yAmplitude;
    await client.command('Input.dispatchMouseEvent', {type:'mouseMoved', x, y, button:'left'});
    step++; await sleep(16);
  }
  await client.command('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1});
  const frames = await client.evaluate('window.__atlasProbeRecording=false; window.__atlasProbeFrames');
  const after = await client.evaluate('window.atlasProbe?.map || null');
  const pins = {before: before?.pins?.length ?? null, after: after?.pins?.length ?? null};
  pins.unchanged = pins.before !== null && pins.before === pins.after;
  if (!pins.unchanged) throw Error(`Pan changed pin count from ${pins.before} to ${pins.after}`);
  const intervals = frames.slice(1).map((value, index) => value - frames[index]);
  return {frameIntervalsMs: aggregate(intervals), samples: intervals.length, pins};
}
async function nav(client, root, path) {
  const target = {root, path};
  const route = '/read/' + [root, ...path.split('/')].map(encodeURIComponent).join('/');
  await client.evaluate(`location.assign(${JSON.stringify(route)})`);
  const targetJSON = JSON.stringify(target);
  await waitFor(client, `window.atlasProbe?.view === 'read' && JSON.stringify(window.atlasProbe?.target) === ${JSON.stringify(targetJSON)} && document.getElementById('document-title')?.textContent`, 'document target');
  await client.evaluate(`document.getElementById('reading').scrollTo(0, 400)`);
  const documentState = await state(client);
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('header button')].find(node => node.textContent.trim().startsWith('Whole map'));
    if (!button) throw Error('Whole map button is unavailable');
    button.click();
  })()`);
  await waitFor(client, `window.atlasProbe?.view === 'map'`, 'map view');
  await waitForSettle(client);
  const mapView = await client.evaluate('window.atlasProbe.map.view');
  const fileLoads = await client.evaluate(`performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/api/file').length`);
  await client.evaluate('history.back()');
  await waitFor(client, `window.atlasProbe?.view === 'read'`, 'Back document');
  await waitFor(client, `performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/api/file').length > ${fileLoads}`, 'Back document load');
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const backState = await state(client);
  await client.evaluate('history.forward()');
  await waitFor(client, `window.atlasProbe?.view === 'map'`, 'Forward map');
  await waitForSettle(client);
  const forwardView = await client.evaluate('window.atlasProbe.map.view');
  return {
    document:{location:documentState.location, scrollY:documentState.scrollY},
    map:{view:mapView},
    back:{location:backState.location, scrollY:backState.scrollY, scrollRestored:backState.scrollY === documentState.scrollY},
    forward:{view:forwardView, viewRestored:sameMapView(forwardView, mapView)}
  };
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [command, value, path] = argv;
  const client = await (dependencies.pageClient || pageClient)();
  const navigate = dependencies.nav || nav;
  try {
    if (command === 'state') return {probe:'browser-state', ...(await state(client))};
    if (command === 'key' && value) return {probe:'browser-key', ...(await key(client, value))};
    if (command === 'shot' && value) return {probe:'browser-shot', ...(await shot(client, value, path || 1600, argv[3] || 1000))};
    if (command === 'controls') return {probe:'browser-controls', ...(await controls(client))};
    if (command === 'layout' && /^\d+$/.test(value || '') && Number(value) > 0) return {probe:'browser-layout', count:Number(value), ...(await layouts(client, Number(value)))};
    if (command === 'pan' && Number(value) > 0) return {probe:'browser-pan', seconds:Number(value), ...(await pan(client, Number(value)))};
    if (command === 'nav' && value && path) return {probe:'browser-nav', ...(await navigate(client, value, path))};
    throw Error('Usage: probe_browser.js <state|key KEYS|shot FILE [WIDTH] [HEIGHT]|controls|layout N|pan SECONDS|nav ROOT PATH>');
  } finally { client.socket.close(); }
}
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => { console.log(JSON.stringify({probe:'browser', error:error.message})); process.exitCode = 1; });
module.exports = {CDPClient, aggregate, controls, diagramState, key, main, nav, percentile, sameMapView, selectTarget, settledMeasurement, shot, waitForSettle};
