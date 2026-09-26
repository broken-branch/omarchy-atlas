'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {parseArgs, hub, framing, view} = require('../../scripts/preview.js');

test('preview parses marketplace defaults and overrides', () => {
  const out = path.resolve('preview.png');
  assert.deepEqual(parseArgs(['preview.png']), {out, theme:'tokyo-night', size:{width:1600,height:900}, scale:2});
  assert.deepEqual(parseArgs(['preview.png', '--theme', 'light', '--size', '1200x800', '--scale', '1']),
    {out, theme:'light', size:{width:1200,height:800}, scale:1});
  for (const args of [[], ['--theme','x'], ['out.png','--size','bad'], ['out.png','--size','0x9'], ['out.png','--scale','0'], ['out.png','--scale','NaN'], ['out.png','--other','x'], ['out.png','--theme']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('preview selects the most referenced indexed file', () => {
  assert.deepEqual(hub({files:[{root:'a',path:'first.md'},{root:'b',path:'hub.md'}], references:[
    {to:{root:'b',path:'hub.md'}}, {to:{root:'b',path:'hub.md'}}, {to:{root:'a',path:'first.md'}}
  ]}), {root:'b',path:'hub.md'});
});

test('preview sizes only the hub root cluster and keeps its rings below the top margin', () => {
  const size = {width:1600, height:900}, hubNode = {root:'b', path:'hub.md', x:0, y:0, heat:0, neighbour:false};
  const point = (root, name, x, y, extra = {}) => ({root, path:`${name}.md`, x, y, heat:0, neighbour:false, ...extra});
  // The top placement bound is 279 / 90 = 3.1, leaving four 1.3 steps.
  const own = [hubNode, point('b', 'up', 0, -90), point('b', 'down', 0, 0)];
  const k = 1.3 * 1.3 * 1.3 * 1.3;
  assert.deepEqual(framing({zoom:1, previewNodes:own}, hubNode, size), {centre:hubNode, keys:['+','+','+','+'], lift:45, camera:{x:0, y:45 / k, k}});
  const crossRoot = [...own, point('c', 'far-neighbour', 0, -1000, {neighbour:true, heat:1}), point('c', 'far-ring', 800, 0, {heat:1})];
  assert.deepEqual(framing({zoom:1, previewNodes:crossRoot}, hubNode, size).keys, ['+','+','+','+']);
  // At four steps the upper file's ring enters the reserved 14% top margin.
  const ring = own.map(point => point.path === 'up.md' ? {...point, heat:1} : point);
  assert.deepEqual(framing({zoom:1, previewNodes:ring}, hubNode, size).keys, ['+','+','+']);
  // A wide cluster uses 60% of the width, even when its height allows more.
  const wide = [hubNode, point('b', 'left', -300, 0), point('b', 'right', 300, 0)];
  assert.deepEqual(framing({zoom:1, previewNodes:wide}, hubNode, size).keys, ['+']);
  // This cluster's 200-unit height limits zoom to 70% of 900, before margins do.
  const tall = [hubNode, point('b', 'top', 0, -70), point('b', 'bottom', 0, 130)];
  assert.deepEqual(framing({zoom:1, previewNodes:tall}, hubNode, size).keys, ['+','+','+','+']);
  assert.deepEqual(framing({zoom:4, previewNodes:own}, hubNode, size).keys, ['-']);
});

test('preview drives the page, waits for settled paint, and captures 1600 by 900 at scale 2', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-test-'));
  const configHome = path.join(outDir, 'config');
  fs.mkdirSync(path.join(configHome, 'omarchy-atlas'), {recursive:true});
  fs.writeFileSync(path.join(configHome, 'omarchy-atlas/server-secret'), 'ab'.repeat(32));
  const out = path.join(outDir, 'preview.png');
  const calls = [], probe = {view:'', map:{cooled:false, fieldPaints:0, zoom:1,
    previewNodes:[{root:'b',path:'hub.md',x:20,y:30,heat:0}, {root:'b',path:'red.md',x:120,y:30,heat:2},
      {root:'b',path:'orange.md',x:20,y:130,heat:1}], panPoint:{x:100, y:80, node:null}, view:{selected:null, center:{x:0,y:0}, controlsHidden:false}}};
  const document = {getElementById(id) { return id === 'toolbar' ? {hidden:toolbarHidden} : null; }};
  let toolbarHidden = false, closed = false, pressed = null;
  const client = {
    socket:{close() { closed = true; }},
    async command(method, params) {
      calls.push({method, params});
      if (method === 'Page.navigate') {
        probe.view = 'map'; probe.map.cooled = true;
        probe.map.view.selected = {root:'b',path:'hub.md'};
      }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
        if (params.key === 'z') toolbarHidden = true;
        if (params.key === 'c') probe.map.view.controlsHidden = true;
        if (params.key === '0') probe.map.view.center = {x:20,y:30};
        if (params.key === '+') probe.map.zoom *= 1.3;
        if (params.key === '-') probe.map.zoom /= 1.3;
      }
      // A drag on the canvas moves the graph with the pointer.
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pressed = params.y;
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') probe.map.view.center.y += (pressed - params.y) / probe.map.zoom;
      if (method === 'Page.captureScreenshot') {
        assert.equal(probe.map.fieldPaints, 7);
        return {data:Buffer.from('png').toString('base64')};
      }
      return {};
    },
    async evaluate(expression) {
      calls.push({evaluate:expression});
      return vm.runInNewContext(expression, {window:{atlasProbe:probe}, document}, {timeout:1000});
    }
  };
  try {
    await view(client, 'http://127.0.0.1:4188', out, {width:1600,height:900}, 2, {
      configHome,
      fetch:async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:4188/api/index');
        assert.equal(options.headers.Authorization, 'Bearer ' + crypto.createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update('atlas-browser\n127.0.0.1:4188').digest('hex'));
        return {json:async () => ({files:[{root:'a',path:'first.md'},{root:'b',path:'hub.md'}],
        references:[{to:{root:'b',path:'hub.md'}}, {to:{root:'b',path:'hub.md'}}]})};
      },
      sleep:async ms => { calls.push({sleep:ms}); probe.map.fieldPaints += ms === 450 ? 5 : 1; }
    });
    assert.deepEqual(calls.find(call => call.method === 'Emulation.setDeviceMetricsOverride').params,
      {width:1600,height:900,deviceScaleFactor:2,mobile:false});
    assert.equal(calls.find(call => call.method === 'Page.navigate').params.url, 'http://127.0.0.1:4188/map/b/hub.md');
    // The 100-unit cluster height and bottom placement bound allow five steps.
    const k = 1.3 * 1.3 * 1.3 * 1.3 * 1.3;
    assert.deepEqual(calls.filter(call => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'keyDown').map(call => call.params.key), ['z','c','0','+','+','+','+','+']);
    const mouse = calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => [call.params.type, call.params.x, call.params.y]);
    assert.deepEqual([mouse[0], mouse.at(-1)], [['mousePressed', 100, 80], ['mouseReleased', 100, 35]], 'dragged up 45 px from the clear pan point');
    assert.ok(calls.findIndex(call => call.method === 'Input.dispatchMouseEvent') > calls.findLastIndex(call => call.method === 'Input.dispatchKeyEvent'));
    assert.deepEqual(probe.map.view.center, {x:20, y:30 + 45 / k}, 'the hub 45 px above the middle: 45% of 900');
    assert.ok(Math.abs(probe.map.zoom / k - 1) < 1e-12);
    assert.ok(calls.some(call => call.evaluate?.includes(`view?.center?.y - ${30 + 45 / k}`)));
    assert.ok(calls.some(call => call.evaluate?.includes('map?.cooled === true')));
    assert.ok(calls.some(call => call.evaluate?.includes('controlsHidden === true')));
    const paintBaseline = calls.findIndex(call => call.evaluate === 'window.atlasProbe?.map?.fieldPaints');
    const paintWait = calls.findIndex(call => call.evaluate?.includes('fieldPaints >= 7'));
    assert.ok(paintBaseline > calls.findLastIndex(call => call.evaluate === 'window.atlasProbe?.map?.cooled === true'));
    assert.ok(paintWait > paintBaseline);
    assert.ok(calls.findIndex(call => call.method === 'Page.bringToFront') < paintBaseline);
    assert.ok(calls.findIndex(call => call.method === 'Page.captureScreenshot') > paintWait);
    assert.equal(probe.map.fieldPaints, 7);
    assert.ok(calls.findIndex(call => call.sleep === 450) < calls.findIndex(call => call.method === 'Page.captureScreenshot'));
    assert.deepEqual(calls.slice(-2).map(call => call.method), ['Page.bringToFront','Page.captureScreenshot']);
    assert.deepEqual(calls.at(-1).params, {format:'png',fromSurface:true});
    assert.equal(fs.readFileSync(out, 'utf8'), 'png');
    assert.equal(closed, true);
    assert.equal(calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'), true);
  } finally { fs.rmSync(outDir, {recursive:true, force:true}); }
});
