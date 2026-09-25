const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appSource = fs.readFileSync(path.join(__dirname, '../../reader/app.js'), 'utf8');
const mapSource = fs.readFileSync(path.join(__dirname, '../../reader/map.js'), 'utf8');
const app = import('data:text/javascript;base64,' + Buffer.from(appSource).toString('base64'));
const map = import('data:text/javascript;base64,' + Buffer.from(mapSource).toString('base64'));

test('theme probe reads exactly the three live CSS variables', async () => {
  const {probeTheme} = await app;
  const read = [];
  const theme = probeTheme({getPropertyValue(name) { read.push(name); return ` ${name}-value `; }});
  assert.deepEqual(theme, {'--background':'--background-value', '--foreground':'--foreground-value', '--accent':'--accent-value'});
  assert.deepEqual(read, ['--background', '--foreground', '--accent']);
});

test('map probe snapshot reports timing validity, pan point, visible counts and only pinned document nodes', async () => {
  const {probeSnapshot} = await map;
  const graph = {zoom: () => 1.5};
  const data = {nodes:[
    {file:{root:'one', path:'a.md'}, fx:4, fy:8},
    {file:{root:'one', path:'b.md'}, fx:undefined, fy:2},
    {type:'ghost', fx:3, fy:4}
  ], links:[{}, {}]};
  const panPoint = {x:12, y:20, node:null};
  assert.deepEqual(probeSnapshot(graph, data, true, null, 'layout paused while map hidden', panPoint), {
    zoom:1.5, pins:[{root:'one', path:'a.md', x:4, y:8}], counts:{nodes:3, edges:2}, cooled:true,
    settleMs:null, settleReason:'layout paused while map hidden', panPoint
  });
});

test('pan point is on the topmost canvas and outside every node hit region', async () => {
  const {findPanPoint} = await map;
  const canvas = {getBoundingClientRect:() => ({left:10, top:20, width:100, height:80})};
  const doc = {elementFromPoint(x, y) { return x < 50 ? {} : canvas; }};
  const graph = {zoom:() => 2, screen2GraphCoords:(x, y) => ({x, y})};
  const data = {nodes:[{type:'file', file:{inbound:0}, x:92, y:6.4}]};
  const point = findPanPoint(canvas, doc, graph, data);
  assert.equal(point.x, 102); assert.ok(Math.abs(point.y - 93.6) < 1e-9); assert.equal(point.node, null);
});
