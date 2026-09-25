#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');
const {pageClient, waitFor, capture, sleep} = require('./theme-shots.js');

const project = path.resolve(__dirname, '..');
const rootNames = ['harbor-api', 'lantern-ui', 'ledger-cli', 'field-notes'];

function parseArgs(args) {
  if (!args.length || args[0].startsWith('--')) throw Error('Usage: scripts/preview OUT.png [--theme NAME] [--size WxH] [--scale N]');
  const options = {out:path.resolve(args[0]), theme:'tokyo-night', size:{width:1600, height:900}, scale:2};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!value || !['--theme', '--size', '--scale'].includes(key)) throw Error(`Invalid option: ${key || ''}`);
    if (key === '--theme') options.theme = value;
    if (key === '--size') {
      const match = /^(\d+)x(\d+)$/.exec(value);
      if (!match || +match[1] < 1 || +match[2] < 1) throw Error(`Invalid size: ${value}`);
      options.size = {width:+match[1], height:+match[2]};
    }
    if (key === '--scale') {
      if (!Number.isFinite(+value) || +value <= 0) throw Error(`Invalid scale: ${value}`);
      options.scale = +value;
    }
  }
  return options;
}

function hub(index) {
  const inbound = new Map(index.files.map(file => [`${file.root}\0${file.path}`, 0]));
  for (const ref of index.references || []) if (ref.to) {
    const key = `${ref.to.root}\0${ref.to.path}`;
    if (inbound.has(key)) inbound.set(key, inbound.get(key) + 1);
  }
  const file = [...index.files].sort((a, b) => (inbound.get(`${b.root}\0${b.path}`) || 0) - (inbound.get(`${a.root}\0${a.path}`) || 0))[0];
  if (!file) throw Error('Demo index has no files');
  return {root:file.root, path:file.path};
}

// The marketplace card crops the picture to about its top half at 2:1, so the
// hub sits at 45% of the height. Its root cluster fills up to 70% of the
// height or 60% of the width, then the 1.3 zoom steps (the map's +/- keys)
// leave room for the root label and status line above 14% of the height.
// A cluster is its files within 2.5 deviations of its centre on each axis.
// Only recency rings in that cluster need to fit; other roots can be cropped.
const HUB_HEIGHT = .45, SIDE = 60, BOTTOM = 48, TOP = .14, RING = 24, STEP = 1.3;
function cluster(points) {
  const spread = axis => {
    const mean = points.reduce((sum, point) => sum + point[axis], 0) / points.length;
    return [mean, Math.sqrt(points.reduce((sum, point) => sum + (point[axis] - mean) ** 2, 0) / points.length)];
  };
  const [mx, sx] = spread('x'), [my, sy] = spread('y');
  return points.filter(point => Math.abs(point.x - mx) <= 2.5 * sx && Math.abs(point.y - my) <= 2.5 * sy);
}
function framing(probe, target, size) {
  const points = probe.previewNodes || [];
  const centre = points.find(point => point.root === target.root && point.path === target.path);
  if (!centre || !Number.isFinite(probe.zoom) || probe.zoom <= 0) throw Error('Hub position or map zoom unavailable');
  const framed = cluster(points.filter(point => point.root === target.root));
  const {width, height} = size, above = height * (HUB_HEIGHT - TOP), below = height * (1 - HUB_HEIGHT) - BOTTOM;
  const xs = framed.map(point => point.x), ys = framed.map(point => point.y);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  let limit = Math.min(spanX ? width * .6 / spanX : Infinity, spanY ? height * .7 / spanY : Infinity);
  if (!Number.isFinite(limit)) limit = 3;
  for (const point of framed) {
    const dx = Math.abs(point.x - centre.x), dy = point.y - centre.y;
    if (dx) limit = Math.min(limit, (width / 2 - SIDE) / dx);
    if (dy) limit = Math.min(limit, dy < 0 ? above / -dy : below / dy);
  }
  let steps = Math.max(-10, Math.min(10, Math.floor(Math.log(limit / probe.zoom) / Math.log(STEP) + 1e-9)));
  const cut = k => framed.some(point => {
    if (!point.heat) return false;
    const x = width / 2 + (point.x - centre.x) * k, y = height * HUB_HEIGHT + (point.y - centre.y) * k;
    return x < RING || x > width - RING || y < height * TOP + RING || y > height - RING;
  });
  while (steps > -10 && cut(probe.zoom * STEP ** steps)) steps--;
  let k = probe.zoom;
  for (let i = 0; i < Math.abs(steps); i++) k = steps < 0 ? k / STEP : k * STEP;
  // Dragging the map up by 5% of the height lifts the centred hub to 45%.
  const lift = Math.round(height * (.5 - HUB_HEIGHT));
  return {centre, keys:Array(Math.abs(steps)).fill(steps < 0 ? '-' : '+'), lift, camera:{x:centre.x, y:centre.y + lift / k, k}};
}

async function key(client, value) {
  await client.command('Input.dispatchKeyEvent', {type:'keyDown', key:value, text:value});
  await client.command('Input.dispatchKeyEvent', {type:'keyUp', key:value});
}

async function drag(client, point, dy) {
  const mouse = (type, y, extra = {}) => client.command('Input.dispatchMouseEvent', {type, x:point.x, y, button:'left', ...extra});
  await mouse('mousePressed', point.y, {buttons:1, clickCount:1});
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', point.y + dy * i / 5, {buttons:1});
  await mouse('mouseReleased', point.y + dy, {buttons:0, clickCount:1});
}

async function view(client, serverURL, out, size, scale, dependencies = {}) {
  const index = await (await (dependencies.fetch || fetch)(`${serverURL}/api/index`)).json();
  const target = hub(index);
  const route = '/map/' + [target.root, ...target.path.split('/')].map(encodeURIComponent).join('/');
  try {
    await client.command('Emulation.setFocusEmulationEnabled', {enabled:true});
    await client.command('Emulation.setDeviceMetricsOverride', {width:size.width, height:size.height, deviceScaleFactor:scale, mobile:false});
    await client.command('Page.navigate', {url:serverURL + route});
    await client.command('Page.bringToFront');
    await waitFor(client, `window.atlasProbe?.view === 'map' && JSON.stringify(window.atlasProbe?.map?.view?.selected) === ${JSON.stringify(JSON.stringify(target))}`, 'hub selection', 200, dependencies.sleep || sleep);
    await waitFor(client, 'window.atlasProbe?.map?.cooled === true', 'map layout', 200, dependencies.sleep || sleep);
    const probe = await client.evaluate('window.atlasProbe?.map');
    const frame = framing(probe, target, size), wait = dependencies.sleep || sleep;
    for (const value of ['z', 'c', '0']) await key(client, value);
    const near = (x, y, k) => `Math.abs(window.atlasProbe?.map?.view?.center?.x - ${x}) < 1 && Math.abs(window.atlasProbe?.map?.view?.center?.y - ${y}) < 1 && Math.abs(window.atlasProbe?.map?.zoom / ${k} - 1) < 1e-6`;
    await waitFor(client, near(frame.centre.x, frame.centre.y, probe.zoom), 'hub centred', 200, wait);
    // Each zoom key scales the zoom it reads, so the next waits for its tween.
    let k = probe.zoom;
    for (const value of frame.keys) {
      k = value === '+' ? k * 1.3 : k / 1.3;
      await key(client, value);
      await waitFor(client, near(frame.centre.x, frame.centre.y, k), 'zoom step', 200, wait);
    }
    // The pan starts on a point of the canvas with no file under it; the
    // pointer ends over the same graph point, so it hovers nothing.
    const panPoint = await client.evaluate('window.atlasProbe?.map?.panPoint');
    if (!panPoint) throw Error('No clear point on the map to pan from');
    await drag(client, panPoint, -frame.lift);
    await waitFor(client, near(frame.camera.x, frame.camera.y, frame.camera.k), 'hub at 45% of the height', 200, wait);
    await waitFor(client, "document.getElementById('toolbar')?.hidden === true && window.atlasProbe?.map?.view?.controlsHidden === true", 'hidden controls', 200, dependencies.sleep || sleep);
    await (dependencies.sleep || sleep)(450);
    await waitFor(client, 'window.atlasProbe?.map?.cooled === true', 'final map layout', 200, dependencies.sleep || sleep);
    await client.command('Page.bringToFront');
    const fieldPaints = await client.evaluate('window.atlasProbe?.map?.fieldPaints');
    if (!Number.isFinite(fieldPaints)) throw Error('Map field paint counter unavailable');
    await waitFor(client, `window.atlasProbe?.map?.fieldPaints >= ${fieldPaints + 2}`, 'two field paints', 200, dependencies.sleep || sleep);
    await capture(client, out);
    return target;
  } finally { client.socket.close(); }
}

function checked(command, args, env) {
  const result = spawnSync(command, args, {env, encoding:'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Server is starting. */ }
    await sleep(100);
  }
  throw Error(`Atlas server did not start: ${url}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve));
  process.kill(child.pid, 'SIGTERM');
  await done;
}

async function main(args) {
  const {out, theme, size, scale} = parseArgs(args);
  const source = path.isAbsolute(theme) ? theme : path.join(os.homedir(), '.config/omarchy/themes', theme);
  const themeDir = fs.existsSync(path.join(source, 'colors.toml')) ? source : path.join('/usr/share/omarchy/themes', theme);
  if (!fs.existsSync(path.join(themeDir, 'colors.toml'))) throw Error(`Theme missing: ${theme}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-'));
  let server, browser;
  try {
    const home = path.join(temp, 'home');
    const state = path.join(home, '.local/state/omarchy/current/theme');
    fs.mkdirSync(state, {recursive:true});
    fs.cpSync(themeDir, state, {recursive:true});
    const env = {...process.env, HOME:home, XDG_CONFIG_HOME:path.join(home, '.config'), XDG_CACHE_HOME:path.join(home, '.cache')};
    const workspace = path.join(temp, 'workspace');
    checked('python3', ['-B', path.join(project, 'scripts/demo-workspace.py'), workspace], env);
    for (const name of rootNames) checked('python3', ['-B', path.join(project, 'atlas.py'), 'root-add', path.join(workspace, name)], env);
    const serverPort = await freePort(), cdpPort = await freePort();
    const serverURL = `http://127.0.0.1:${serverPort}`;
    server = spawn('python3', ['-B', path.join(project, 'atlas.py'), 'serve', '--port', String(serverPort)], {env, stdio:'ignore'});
    await ready(`${serverURL}/theme.css`);
    browser = spawn('chromium', ['--headless=new', '--no-first-run', `--user-data-dir=${path.join(home, 'chromium')}`, `--remote-debugging-port=${cdpPort}`, `--window-size=${size.width},${size.height}`, `--force-device-scale-factor=${scale}`, `${serverURL}/map`], {env, stdio:'ignore'});
    const client = await pageClient(`http://127.0.0.1:${cdpPort}`, serverURL);
    const target = await view(client, serverURL, out, size, scale);
    process.stdout.write(`${out}: ${target.root}/${target.path}\n`);
  } finally {
    await stop(browser);
    await stop(server);
    fs.rmSync(temp, {recursive:true, force:true});
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {parseArgs, hub, framing, view};
