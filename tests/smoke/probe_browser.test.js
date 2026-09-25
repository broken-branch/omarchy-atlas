const {test} = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CDPClient, aggregate, main, sameMapView, selectTarget, settledMeasurement, shot, waitForSettle} = require('./probe_browser.js');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/smoke', name), 'utf8'));

test('nav waits for navigation before main closes the client', async () => {
  const events = [];
  const client = {socket:{close() { events.push('close'); }}, evaluate() {
    return new Promise(resolve => process.nextTick(() => { events.push('evaluate'); resolve(); }));
  }};
  const result = await main(['nav', 'omarchy-atlas', 'docs/design.md'], {
    pageClient: async () => client,
    nav: async current => { await current.evaluate('navigation'); return {ready:true}; }
  });
  assert.deepEqual(result, {probe:'browser-nav', ready:true});
  assert.deepEqual(events, ['evaluate', 'close']);
});

test('controls probe evaluates browser control geometry without screenshots', async () => {
  const events = [];
  const client = {socket:{close() { events.push('close'); }}, evaluate(expression) {
    events.push(expression);
    return Promise.resolve({root:{fontSize:'1rem'}});
  }};
  const result = await main(['controls'], {pageClient: async () => client});
  assert.deepEqual(result, {probe:'browser-controls', root:{fontSize:'1rem'}});
  assert.match(events[0], /--font-size-small/);
  assert.match(events[0], /getBoundingClientRect/);
  assert.match(events[0], /\.map-controls button/);
  assert.deepEqual(events.slice(1), ['close']);
});

test('key probe sends trusted CDP key events and waits two frames per character', async () => {
  const events = [];
  const client = {socket:{close() {}}, async command(method, params) { events.push([method, params]); }, async evaluate(expression) {
    events.push(['evaluate', expression]);
    if (expression.includes('const node=document.activeElement')) return {tag:'input', ariaLabel:'Search map', placeholder:null};
    if (expression.includes('window.atlasProbe')) return {view:'map', location:'http://127.0.0.1:4137/map', target:null, theme:null, body:null, code:null, scrollY:0, map:{view:{controlsHidden:true}}, mapControlsHidden:true};
    return {view:'map', location:'http://127.0.0.1:4137/map', target:null, theme:null, body:null, code:null, scrollY:0, map:{view:{controlsHidden:true}}};
  }};
  const result = await main(['key', 'c/'], {pageClient:async () => client});
  assert.equal(result.probe, 'browser-key');
  assert.deepEqual(events.filter(([method]) => method === 'Input.dispatchKeyEvent').map(([, params]) => params), [
    {type:'keyDown', key:'c', code:'KeyC', windowsVirtualKeyCode:67, text:'c'},
    {type:'keyUp', key:'c', code:'KeyC', windowsVirtualKeyCode:67},
    {type:'keyDown', key:'/', code:'Slash', windowsVirtualKeyCode:191, text:'/'},
    {type:'keyUp', key:'/', code:'Slash', windowsVirtualKeyCode:191}
  ]);
  assert.equal(events.filter(([method, expression]) => method === 'evaluate' && String(expression).includes('requestAnimationFrame')).length, 2);
  assert.deepEqual(result.activeElement, {tag:'input', ariaLabel:'Search map', placeholder:null});
  assert.equal(result.mapControlsHidden, true);
});

test('shot captures PNG bytes and restores device metrics', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shot-'));
  const file = path.join(temp, 'map.png');
  const events = [];
  const client = {async command(method, params) {
    events.push([method, params]);
    if (method === 'Page.captureScreenshot') return {data:Buffer.from('png-data').toString('base64')};
    return {};
  }, async evaluate(expression) { return expression.includes('atlasProbe?.view') ? false : undefined; }};
  try {
    const delays = [];
    const result = await shot(client, file, 800, 600, async ms => { delays.push(ms); });
    assert.deepEqual(delays, [2000]);
    assert.deepEqual(result, {file, width:800, height:600, bytes:8});
    assert.equal(fs.readFileSync(file, 'utf8'), 'png-data');
    assert.deepEqual(events.map(([method]) => method), ['Emulation.setDeviceMetricsOverride','Page.captureScreenshot','Emulation.clearDeviceMetricsOverride']);
    assert.deepEqual(events[0][1], {width:800, height:600, deviceScaleFactor:1, mobile:false});
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
});

test('recorded target list selects the Atlas page rather than a worker or another page', () => {
  const target = selectTarget(fixture('cdp-targets.json'));
  assert.equal(target.id, 'atlas');
  assert.equal(selectTarget([], 'http://missing/'), null);
});

test('lifecycle probe reports the reader, popup layer, bar placement, and IPC target distinctly', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lifecycle-'));
  try {
    const clients = path.join(__dirname, '../fixtures/smoke/hypr-clients.json');
    fs.mkdirSync(path.join(temp, 'home/.config/omarchy'), {recursive:true});
    fs.writeFileSync(path.join(temp, 'home/.config/omarchy/shell.json'), JSON.stringify({bar:{layout:{left:[], center:[{id:'clock'}], right:[{id:'io.github.broken-branch.atlas'}]}}}));
    const commands = {
      omarchy: '#!/bin/sh\n[ "$2" = list ] && printf "[]\\n"\n',
      ss: '#!/bin/sh\nexit 0\n',
      ps: '#!/bin/sh\nexit 0\n',
      hyprctl: `#!/bin/sh\nif [ "$2" = layers ]; then printf '%s\\n' '{"DP-1":{"levels":{"2":[{"namespace":"omarchy-keyboard-panel","x":10}]}}}'; else exec cp '${clients}' /dev/stdout; fi\n`,
      qs: '#!/bin/sh\nprintf "%s\\n" "target other" "  function ping()" "target io.github.broken-branch.atlas" "  function toggle()" "  function open()" "  function close()" "target final"\n'
    };
    for (const [name, source] of Object.entries(commands)) {
      const command = path.join(temp, name); fs.writeFileSync(command, source, {mode:0o755});
    }
    const result = childProcess.spawnSync('sh', [path.join(__dirname, 'probe_lifecycle.sh')], {
      encoding:'utf8', env:{...process.env, HOME:path.join(temp, 'home'), PATH:`${temp}:${process.env.PATH}`}
    });
    assert.equal(result.status, 0, result.stderr);
    const probe = JSON.parse(result.stdout);
    assert.deepEqual(probe.atlasTitleClients.map(client => client.address), ['0xreader']);
    assert.deepEqual(probe.popupLayers, [{namespace:'omarchy-keyboard-panel', x:10}]);
    assert.equal(probe.barWidgetPlaced, true);
    assert.deepEqual(probe.ipcTarget, ['function toggle()', 'function open()', 'function close()']);
    assert.equal(Object.hasOwn(probe, 'panelTitleClients'), false);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});

test('nav restoration compares map camera and selection but not pins', () => {
  const initial = {zoom:1.5, center:{x:12, y:-4}, selected:{root:'alpha', path:'README.md'}, pins:[]};
  assert.equal(sameMapView(initial, {...initial, pins:[{root:'alpha', path:'README.md', x:1, y:2}]}), true);
  assert.equal(sameMapView(initial, {...initial, zoom:1.6}), false);
  assert.equal(sameMapView(initial, {...initial, center:{x:13, y:-4}}), false);
  assert.equal(sameMapView(initial, {...initial, selected:{root:'alpha', path:'other.md'}}), false);
  assert.equal(sameMapView(initial, {zoom:1.5, centre:{x:12, y:-4}, selected:initial.selected}), false);
  assert.equal(sameMapView(initial, null), false);
});

test('CDP message framing pairs an out-of-order reply with its command', async () => {
  const listeners = new Map(), sent = [];
  const socket = {addEventListener(type, listener) { listeners.set(type, listener); }, send(frame) { sent.push(JSON.parse(frame)); }};
  const client = new CDPClient(socket);
  const first = client.command('Runtime.evaluate', {expression:'1'});
  const second = client.command('Input.dispatchMouseEvent', {type:'mouseMoved'});
  listeners.get('message')({data: JSON.stringify({id:2, result:{ok:true}})});
  listeners.get('message')({data: Buffer.from(JSON.stringify({id:1, result:{result:{value:1}}}))});
  assert.deepEqual(await second, {ok:true}); assert.deepEqual(await first, {result:{value:1}});
  assert.deepEqual(sent.map(message => message.id), [1, 2]);
});

test('recorded settle and frame values use median, p95, and worst aggregation', () => {
  const values = fixture('measurements.json');
  assert.deepEqual(aggregate(values.settleMs), {median:14, p95:23.4, worst:25});
  assert.deepEqual(aggregate(values.frameIntervalsMs), {median:16, p95:19.4, worst:20});
  assert.deepEqual(values.pins, {before:1, after:1, unchanged:true});
  assert.equal(settledMeasurement(values.converged), 917);
  assert.throws(() => settledMeasurement(values.capped), /cooldown-cap/);
  assert.equal(settledMeasurement({cooled:false, settleMs:null, settleReason:null}), null);
  assert.deepEqual(aggregate([]), {median:null, p95:null, worst:null});
});

test('removing the paused-layout workspace result makes navigation wait for the generic timeout', async () => {
  const paused = {cooled:false, settleMs:null, settleReason:'layout paused while map hidden'};
  const client = {evaluate: async () => paused};
  await assert.rejects(waitForSettle(client), /reader window must be on the active workspace/);
});

test('removing the two-second frame guard hides an inactive workspace with the generic timeout', async () => {
  const client = {evaluate: expression => expression.startsWith('window.') ? Promise.resolve({cooled:false, settleMs:null, settleReason:null}) : new Promise(() => {})};
  await assert.rejects(waitForSettle(client, 100, 5), /reader window must be on the active workspace/);
});
