#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {CDPClient, selectTarget} = require('../tests/smoke/probe_browser.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pageClient(cdpURL, serverURL, getTargets = async url => (await (await fetch(`${url}/json/list`)).json()), connect = async target => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', reject, {once:true});
  });
  return new CDPClient(socket);
}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const target = selectTarget(await getTargets(cdpURL), serverURL);
      if (target) return connect(target);
    } catch { /* Chromium may still be starting. */ }
    await sleep(100);
  }
  throw Error(`No Atlas page target starts with ${serverURL}`);
}

function parseCaptureArgs(args) {
  const [theme, expected, serverURL, cdpURL, out, size = '1600x1000', scale = '1', readTarget = '', ...roots] = args;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) throw Error(`Invalid capture size: ${size}`);
  if (!Number.isFinite(Number(scale)) || Number(scale) <= 0) throw Error(`Invalid device scale: ${scale}`);
  if (!roots.length) throw Error('At least one root is required');
  return {theme, expected, serverURL, cdpURL, out, size:{width:Number(match[1]), height:Number(match[2])}, scale:Number(scale), readTarget, roots};
}

function viewList(theme) {
  return {map:`${theme}-map.png`, reader:`${theme}-reader.png`, neighbourhood:`${theme}-neighbourhood.png`};
}

function summaryRow(theme, expected, actual, views, size, scale, roots) {
  const normal = value => value.trim().toLowerCase();
  return {theme, expectedBackground:expected, computedBackground:actual,
    colourMatch:normal(expected) === normal(actual), views, size, scale, roots};
}

function summary(rows) {
  return {themes:rows, allColourMatches:rows.length > 0 && rows.every(row => row.colourMatch)};
}

async function waitFor(client, expression, label, attempts = 200, pause = sleep, explain = null) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await client.evaluate(expression)) return;
    await pause(100);
  }
  throw Error(`${label} did not become ready${explain ? await explain() : ''}`);
}

async function waitForCamera(client, pause = sleep, maxWait = 2000) {
  const interval = 150, attempts = Math.ceil(maxWait / interval);
  let previous;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const zoom = await client.evaluate('window.atlasProbe?.map?.view?.zoom');
    if (typeof zoom === 'number' && zoom === previous) return;
    previous = zoom;
    if (attempt + 1 < attempts) await pause(interval);
  }
  throw Error(`map camera did not settle within ${maxWait} ms`);
}

// The exceptions and console errors the page reports, from Runtime.enable on.
function pageErrors(client) {
  const errors = [];
  client.socket.addEventListener?.('message', event => {
    let message;
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString()); } catch { return; }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push(`exception: ${details.exception?.description || details.text} (${details.url || 'page'}:${details.lineNumber + 1}:${details.columnNumber + 1})`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
    }
  });
  return errors;
}

// What the page showed when a wait gave up: the map probe twice, a second
// apart, so layouts that keep restarting or a graph loop that stopped show in
// the counts, and the page's exceptions and console errors.
const PAGE_STATE = `JSON.stringify((() => { const map = window.atlasProbe?.map; return {view:window.atlasProbe?.view, visibility:document.visibilityState,
  map:map && {cooled:map.cooled, settleMs:map.settleMs, settleReason:map.settleReason, counts:map.counts, scope:map.scope, view:map.view,
    layouts:map.layouts, graphFrames:map.graphFrames, fieldPaints:map.fieldPaints}}; })())`;
function explainer(client, errors, pause) {
  const sample = async () => { try { return await client.evaluate(PAGE_STATE); } catch (error) { return `unavailable: ${error.message}`; } };
  return async () => {
    const first = await sample();
    await pause(1000);
    return `\nprobe: ${first}\nprobe 1 s later: ${await sample()}\npage errors: ${errors.length ? errors.slice(-10).join('\n  ') : 'none'}`;
  };
}

async function capture(client, path) {
  await client.command('Page.bringToFront');
  const result = await client.command('Page.captureScreenshot', {format:'png', fromSurface:true});
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
}

async function run(args, dependencies = {}) {
  const {theme, expected, serverURL, cdpURL, out, size, scale, readTarget, roots} = parseCaptureArgs(args);
  const client = await (dependencies.pageClient || pageClient)(cdpURL, serverURL);
  const names = viewList(theme), views = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, `${out}/${name}`]));
  const rootNames = roots.map(root => path.basename(root));
  const pause = dependencies.sleep || sleep, errors = pageErrors(client), explain = explainer(client, errors, pause);
  const ready = (expression, label) => waitFor(client, expression, label, 200, pause, explain);
  try {
    await client.command('Runtime.enable');
    await client.command('Emulation.setFocusEmulationEnabled', {enabled:true});
    await client.command('Emulation.setDeviceMetricsOverride', {width:size.width, height:size.height, deviceScaleFactor:scale, mobile:false});
    await client.command('Page.navigate', {url:`${serverURL}/map`});
    await client.command('Page.bringToFront');
    await ready("window.atlasProbe?.view === 'map'", 'map');
    await ready('window.atlasProbe?.map?.cooled === true', 'map layout');
    await waitForCamera(client, pause);
    const actual = await client.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--background')");
    const index = await (await (dependencies.fetch || fetch)(`${serverURL}/api/index`)).json();
    const file = readTarget ? (() => { const [root, ...parts] = readTarget.split('/'); return index.files.find(item => item.root === root && item.path === parts.join('/')); })()
      : index.files.find(item => item.root === rootNames[0] && item.path === 'README.md') || index.files.find(item => item.root === rootNames[0] && /\.md$/i.test(item.path));
    if (!file) throw Error(readTarget ? `Reader target not indexed: ${readTarget}` : 'First root has no README.md or Markdown file for the reader screenshot');
    await capture(client, views.map);
    const route = '/read/' + [file.root, ...file.path.split('/')].map(encodeURIComponent).join('/');
    await client.command('Page.navigate', {url:serverURL + route});
    await client.command('Page.bringToFront');
    await ready("window.atlasProbe?.view === 'read' && document.getElementById('document-title')?.textContent", 'reader');
    await pause(500);
    await capture(client, views.reader);
    const inbound = new Map(index.files.map(item => [`${item.root}\0${item.path}`, 0]));
    for (const ref of index.references || []) if (ref.to) { const key = `${ref.to.root}\0${ref.to.path}`; if (inbound.has(key)) inbound.set(key, inbound.get(key) + 1); }
    const centre = [...index.files].sort((a,b) => (inbound.get(`${b.root}\0${b.path}`)||0) - (inbound.get(`${a.root}\0${a.path}`)||0))[0];
    if (!centre) throw Error('Index has no file for the neighbourhood screenshot');
    await client.command('Page.navigate', {url:serverURL + '/read/' + [centre.root, ...centre.path.split('/')].map(encodeURIComponent).join('/')});
    await client.command('Page.bringToFront');
    const centreTarget = JSON.stringify({root:centre.root, path:centre.path});
    await ready(`window.atlasProbe?.view === 'read' && JSON.stringify(window.atlasProbe?.target) === ${JSON.stringify(centreTarget)}`, 'neighbourhood source');
    await client.evaluate("document.getElementById('neighbourhood-button')?.click()");
    await ready("window.atlasProbe?.view === 'map' && window.atlasProbe?.map?.scope", 'neighbourhood');
    await ready('window.atlasProbe?.map?.cooled === true', 'neighbourhood layout');
    await waitForCamera(client, pause);
    await capture(client, views.neighbourhood);
    return summaryRow(theme, expected, actual, views, size, scale, roots);
  } finally { client.socket.close(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--summary') {
    const rows = fs.readFileSync(args[1], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const result = summary(rows);
    fs.writeFileSync(args[2], JSON.stringify(result, null, 2) + '\n');
    if (!result.allColourMatches) process.exitCode = 1;
  } else {
    run(args).then(row => {
      process.stdout.write(JSON.stringify(row) + '\n');
    }).catch(error => { console.error(error); process.exitCode = 1; });
  }
}

module.exports = {pageClient, summary, summaryRow, parseCaptureArgs, viewList, run, waitFor, waitForCamera, capture, sleep};
