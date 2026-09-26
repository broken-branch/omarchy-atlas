'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {pageClient, summary, summaryRow, parseCaptureArgs, viewList, run, waitFor, waitForCamera, installFixtureToken} = require('../../scripts/theme-shots.js');

test('fixture capture enables Page before installing the origin token', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-capture-auth-'));
  try {
    fs.mkdirSync(path.join(directory, 'omarchy-atlas'));
    fs.writeFileSync(path.join(directory, 'omarchy-atlas/server-secret'), 'ab'.repeat(32));
    const calls = [];
    const token = await installFixtureToken({command:async (...args) => calls.push(args)}, 'http://127.0.0.1:4188', directory);
    assert.equal(calls[0][0], 'Page.enable');
    assert.equal(calls[1][0], 'Page.addScriptToEvaluateOnNewDocument');
    assert.match(calls[1][1].source, /sessionStorage\.setItem\('atlas-browser-token'/);
    assert.ok(calls[1][1].source.includes(token));
    assert.ok(!calls[1][1].source.includes('ab'.repeat(32)));
    await assert.rejects(installFixtureToken({command:async () => {}}, 'http://127.0.0.1:4188'), /Fixture config directory/);
    await assert.rejects(installFixtureToken({command:async () => {}}, 'https://example.test:4188', directory), /127.0.0.1 HTTP origin/);
  } finally {
    fs.rmSync(directory, {recursive:true, force:true});
  }
});

test('theme shots selects Markdown Atlas page after Chromium welcome tab', async () => {
  const selected = [];
  const client = await pageClient('http://cdp', 'http://127.0.0.1:4567', async () => [
    {type:'page', url:'chrome-extension://welcome', id:'welcome'},
    {type:'background_page', url:'http://127.0.0.1:4567/map', id:'worker'},
    {type:'page', url:'http://127.0.0.1:4567/map', id:'atlas'},
  ], async target => { selected.push(target.id); return {target}; });
  assert.deepEqual(selected, ['atlas']);
  assert.equal(client.target.id, 'atlas');
});

test('theme shots summary marks a mismatch and trims computed value', () => {
  const views = {map:'map.png', reader:'reader.png', neighbourhood:'neighbourhood.png'};
  assert.deepEqual(summaryRow('light', '#f5f1e8', ' #F5F1E8 ', views, {width:1600,height:1000}, 1, ['alpha']), {
    theme:'light', expectedBackground:'#f5f1e8', computedBackground:' #F5F1E8 ',
    colourMatch:true, views, size:{width:1600,height:1000}, scale:1, roots:['alpha']
  });
  assert.equal(summaryRow('dark', '#142133', '#1e1e2e', views, {width:1600,height:1000}, 1, ['alpha']).colourMatch, false);
  assert.equal(summary([summaryRow('dark', '#142133', '#1e1e2e', views, {width:1600,height:1000}, 1, ['alpha'])]).allColourMatches, false);
});

test('theme shots parses size, scale, reader target, and registered roots', () => {
  assert.deepEqual(parseCaptureArgs(['dark','#000','http://atlas','http://cdp','/tmp/out','1920x1080','2','alpha/README.md','alpha','beta']), {
    theme:'dark', expected:'#000', serverURL:'http://atlas', cdpURL:'http://cdp', out:'/tmp/out',
    size:{width:1920,height:1080}, scale:2, readTarget:'alpha/README.md', roots:['alpha','beta']
  });
  assert.throws(() => parseCaptureArgs(['dark','#000','a','b','c','bad','1','','root']), /Invalid capture size/);
});

test('theme shots names map, reader, and neighbourhood views per theme', () => {
  assert.deepEqual(viewList('dark'), {map:'dark-map.png', reader:'dark-reader.png', neighbourhood:'dark-neighbourhood.png'});
});

test('theme shots navigates and captures map, reader, and indexed neighbourhood through CDP', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-theme-shots-'));
  const configHome = path.join(out, 'config');
  fs.mkdirSync(path.join(configHome, 'omarchy-atlas'), {recursive:true});
  fs.writeFileSync(path.join(configHome, 'omarchy-atlas/server-secret'), 'cd'.repeat(32));
  const commands = [], evaluations = [], captures = [];
  const probe = {view:'', target:null, map:null};
  const context = {
    window:{atlasProbe:probe},
    document:{
      documentElement:{},
      getElementById(id) {
        if (id === 'document-title') return {textContent:probe.view === 'read' ? 'Document' : ''};
        if (id === 'neighbourhood-button') return {click() {
          assert.deepEqual(probe.target, {root:'beta', path:'guide.md'});
          probe.view = 'map';
          probe.map = {cooled:true, scope:{root:'beta', path:'guide.md'}, view:{zoom:1}};
        }};
        return null;
      }
    },
    getComputedStyle:() => ({getPropertyValue:() => ' #F5F1E8 '})
  };
  const client = {
    socket:{close() {}},
    async command(method, params) {
      commands.push({method, params});
      if (method === 'Page.navigate') {
        const route = new URL(params.url).pathname;
        probe.view = route === '/map' ? 'map' : 'read';
        probe.target = route === '/map' ? null : (() => {
          const [, , root, ...parts] = route.split('/');
          return {root, path:parts.join('/')};
        })();
        probe.map = route === '/map' ? {cooled:true, scope:null, view:{zoom:1}} : null;
      }
      if (method === 'Page.captureScreenshot') {
        captures.push({view:probe.view, target:probe.target?.root || null, neighbourhood:!!probe.map?.scope});
        return {data:Buffer.from('png').toString('base64')};
      }
      return {};
    },
    async evaluate(expression) {
      evaluations.push(expression);
      return vm.runInNewContext(expression, context, {timeout:1000});
    }
  };
  const index = {
    files:[
      {root:'alpha', path:'README.md'},
      {root:'beta', path:'guide.md'}
    ],
    references:[
      {from:{root:'alpha',path:'README.md'},to:{root:'beta',path:'guide.md'}},
      {from:{root:'alpha',path:'README.md'},to:{root:'beta',path:'guide.md'}}
    ]
  };
  try {
    const row = await run(['light','#f5f1e8','http://127.0.0.1:4188','http://cdp',out,'1920x1080','2','', '/workspace/alpha','/workspace/beta'], {
      configHome,
      pageClient:async () => client,
      fetch:async () => ({json:async () => index}),
      sleep:async () => {}
    });
    const navigations = commands.filter(item => item.method === 'Page.navigate').map(item => item.params.url);
    assert.deepEqual(navigations, [
      'http://127.0.0.1:4188/map',
      'http://127.0.0.1:4188/read/alpha/README.md',
      'http://127.0.0.1:4188/read/beta/guide.md'
    ]);
    assert.equal(evaluations.some(expression => expression.includes("neighbourhood-button") && expression.includes('click')), true);
    assert.equal(commands.filter(item => item.method === 'Page.captureScreenshot').length, 3);
    assert.deepEqual(captures, [
      {view:'map', target:null, neighbourhood:false},
      {view:'read', target:'alpha', neighbourhood:false},
      {view:'map', target:'beta', neighbourhood:true}
    ]);
    probe.view = 'read';
    assert.equal(await client.evaluate("window.atlasProbe?.view === 'read' && document.getElementById('document-title')?.textContent && false"), false);
    assert.deepEqual(commands.filter(item => ['Page.bringToFront', 'Page.captureScreenshot'].includes(item.method)).map(item => item.method),
      ['Page.bringToFront', 'Page.bringToFront', 'Page.captureScreenshot', 'Page.bringToFront', 'Page.bringToFront', 'Page.captureScreenshot',
        'Page.bringToFront', 'Page.bringToFront', 'Page.captureScreenshot']);
    // A fresh profile's extension welcome tab can take the foreground; a hidden
    // tab gets no animation frames, so every navigation brings Markdown Atlas forward.
    const methods = commands.map(item => item.method);
    assert.equal(methods.every((method, index) => method !== 'Page.navigate' || methods[index + 1] === 'Page.bringToFront'), true);
    assert.equal(methods.includes('Emulation.setFocusEmulationEnabled'), true);
    assert.equal(evaluations.some(expression => expression.includes("view === 'read'") && expression.includes('document-title')), true);
    assert.equal(evaluations.some(expression => expression.includes('map?.scope')), true);
    assert.deepEqual(Object.keys(row.views), ['map','reader','neighbourhood']);
    assert.deepEqual(Object.values(row.views).map(file => fs.existsSync(file)), [true,true,true]);
    assert.equal(commands.find(item => item.method === 'Emulation.setDeviceMetricsOverride').params.deviceScaleFactor, 2);
  } finally {
    fs.rmSync(out, {recursive:true, force:true});
  }
});

test('theme shots waits for the cooled map camera to settle before capture', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-theme-shots-'));
  const commands = [], captures = [];
  const probe = {view:'', target:null, map:null};
  let zoomReads = 0;
  const context = {
    window:{atlasProbe:probe},
    document:{documentElement:{}, getElementById(id) {
      if (id === 'document-title') return {textContent:probe.view === 'read' ? 'Document' : ''};
      if (id === 'neighbourhood-button') return {click() { probe.view = 'map'; probe.map = {cooled:true, scope:{root:'beta', path:'guide.md'}, view:{zoom:2.65}}; }};
      return null;
    }},
    getComputedStyle:() => ({getPropertyValue:() => '#000000'})
  };
  const client = {
    socket:{close() {}},
    async command(method, params) {
      commands.push({method, params});
      if (method === 'Page.navigate') {
        const route = new URL(params.url).pathname;
        probe.view = route === '/map' ? 'map' : 'read';
        probe.target = route === '/map' ? null : {root:'beta', path:'guide.md'};
        if (route === '/map') { probe.map = {cooled:true, scope:null, view:{zoom:1.05}}; zoomReads = 0; }
        else probe.map = null;
      }
      if (method === 'Page.captureScreenshot') captures.push(probe.map?.view?.zoom ?? null);
      return method === 'Page.captureScreenshot' ? {data:Buffer.from('png').toString('base64')} : {};
    },
    async evaluate(expression) {
      if (expression.includes('map?.view?.zoom')) {
        zoomReads++;
        if (zoomReads >= 2) probe.map.view.zoom = 2.65;
      }
      return vm.runInNewContext(expression, context, {timeout:1000});
    }
  };
  try {
    await run(['dark','#000000','http://atlas','http://cdp',out,'1600x1000','1','','/workspace/alpha','/workspace/beta'], {
      token:'fixture',
      pageClient:async () => client,
      fetch:async () => ({json:async () => ({files:[{root:'alpha', path:'README.md'}, {root:'beta', path:'guide.md'}],
        references:[{from:{root:'alpha', path:'README.md'}, to:{root:'beta', path:'guide.md'}}]})}),
      sleep:async ms => { assert.ok(ms >= 0); }
    });
    assert.deepEqual(captures, [2.65, null, 2.65], 'map captures see settled zoom; the reader has no map');
    assert.ok(zoomReads >= 4, 'camera was sampled across the post-cooldown change');
  } finally { fs.rmSync(out, {recursive:true, force:true}); }
});

test('camera settling is capped at two seconds', async () => {
  let reads = 0, pauses = 0;
  await assert.rejects(waitForCamera({evaluate:async () => ++reads}, async ms => { assert.equal(ms, 150); pauses++; }), /did not settle within 2000 ms/);
  assert.equal(reads, 14);
  assert.equal(pauses, 13);
});

test('theme shots fail when a view never becomes ready', async () => {
  const probes = [];
  await assert.rejects(waitFor({evaluate:async expression => { probes.push(expression); return false; }},
    "window.atlasProbe?.view === 'read'", 'reader', 2, async () => {}), /reader did not become ready/);
  assert.deepEqual(probes, ["window.atlasProbe?.view === 'read'", "window.atlasProbe?.view === 'read'"]);
});

test('a neighbourhood that never settles reports the probe twice and the page errors', async () => {
  const listeners = [], pauses = [];
  const emit = message => listeners.forEach(listener => listener({data:JSON.stringify(message)}));
  const probe = {view:'', target:null, map:null};
  let layouts = 1;
  const context = {window:{atlasProbe:probe}, document:{documentElement:{}, visibilityState:'visible', getElementById(id) {
    if (id === 'document-title') return {textContent:probe.view === 'read' ? 'Document' : ''};
    if (id === 'neighbourhood-button') return {click() {
      probe.view = 'map';
      probe.map = {cooled:false, settleMs:null, settleReason:null, counts:{nodes:55, edges:58}, scope:{root:'beta', path:'guide.md'},
        view:{zoom:1, center:{x:0, y:0}}, get layouts() { return layouts++; }, graphFrames:12, fieldPaints:40};
      emit({method:'Runtime.exceptionThrown', params:{exceptionDetails:{text:'Uncaught', exception:{description:'TypeError: x is not a function'}, url:'http://atlas/map.js', lineNumber:9, columnNumber:4}}});
      emit({method:'Runtime.consoleAPICalled', params:{type:'error', args:[{type:'string', value:'boom'}]}});
    }};
    return null;
  }}, getComputedStyle:() => ({getPropertyValue:() => '#000000'})};
  const commands = [];
  const client = {
    socket:{close() {}, addEventListener(type, listener) { if (type === 'message') listeners.push(listener); }},
    async command(method, params) {
      commands.push(method);
      if (method === 'Page.navigate') {
        const route = new URL(params.url).pathname, [, view, root, ...parts] = route.split('/');
        probe.view = view; probe.target = view === 'read' ? {root, path:parts.join('/')} : null;
        probe.map = view === 'map' ? {cooled:true, scope:null, view:{zoom:1}} : null;
      }
      return method === 'Page.captureScreenshot' ? {data:Buffer.from('png').toString('base64')} : {};
    },
    async evaluate(expression) { return vm.runInNewContext(expression, context, {timeout:1000}); }
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-theme-shots-'));
  try {
    const failure = await run(['dark','#000000','http://atlas','http://cdp',out,'1600x1000','1','','/workspace/alpha','/workspace/beta'], {
      token:'fixture',
      pageClient:async () => client, sleep:async ms => { pauses.push(ms); },
      fetch:async () => ({json:async () => ({files:[{root:'alpha', path:'README.md'}, {root:'beta', path:'guide.md'}],
        references:[{from:{root:'alpha', path:'README.md'}, to:{root:'beta', path:'guide.md'}}]})})
    }).then(() => null, error => error.message);
    assert.equal(commands[0], 'Runtime.enable', 'errors are recorded from the first page on');
    const [label, first, later, ...errors] = failure.split('\n');
    assert.equal(label, 'neighbourhood layout did not become ready');
    assert.deepEqual(JSON.parse(first.replace('probe: ', '')), {view:'map', visibility:'visible', map:{cooled:false, settleMs:null, settleReason:null,
      counts:{nodes:55, edges:58}, scope:{root:'beta', path:'guide.md'}, view:{zoom:1, center:{x:0, y:0}}, layouts:1, graphFrames:12, fieldPaints:40}});
    assert.equal(JSON.parse(later.replace('probe 1 s later: ', '')).map.layouts, 2, 'the second sample shows the layout started again');
    assert.equal(pauses.filter(ms => ms === 1000).length, 1, 'the samples are a second apart');
    assert.deepEqual(errors, ['page errors: exception: TypeError: x is not a function (http://atlas/map.js:10:5)', '  console.error: boom']);
  } finally { fs.rmSync(out, {recursive:true, force:true}); }
});
