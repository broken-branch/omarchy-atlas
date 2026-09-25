const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const {execFileSync} = require('node:child_process')
const test = require('node:test')
const root = path.resolve(__dirname, '../..')
const bridge = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(root, 'PanelBridge.js'), 'utf8').replace('.pragma library', ''), bridge)
const plain = value => JSON.parse(JSON.stringify(value))

function panel() {
    const source = fs.readFileSync(path.join(root, 'Panel.qml'), 'utf8')
    const context = vm.createContext({
        PanelBridge: bridge, Array, Object, String,
        page: 'kind-editor', kindTable: [], kindDraft: {}, kindsBusy: false, kindsError: '', kindsErrorField: '',
        selectedKinds: [], query: '', calls: [],
        enqueue: (...args) => context.calls.push(args), focusPopup: () => {},
        refreshIndex: () => context.calls.push(['refresh']),
        openRoots: () => context.calls.push(['roots']),
        index: {}, searchMatches: [], costRows: [], noRoots: false, refreshError: '', indexedAt: '', registeredRoots: []
    })
    for (const name of ['editKind', 'openKinds', 'changeKind', 'handleReply', 'handleFailure']) {
        const match = source.match(new RegExp('    function ' + name + '\\([^]*?\\n    }'))
        assert.ok(match, name)
        vm.runInContext(match[0], context)
    }
    return context
}

const kind = {id: 'notes', label: 'Plain notes', colour: '#123456', builtin: false, overridden: false,
    match: {paths: ['docs/'], extensions: ['.txt']}}
const reply = (command, data, extra = {}) => ({command,
    stdout: JSON.stringify({version: 1, command, ok: true, data, ...extra}) + '\n'})

test('kind editor preserves the rule and serializes values as literal argv', () => {
    const ui = panel()
    ui.editKind(kind)
    assert.equal(ui.page, 'kind-editor')
    assert.equal(ui.kindDraft.extensions, '.txt')
    assert.equal(ui.kindDraft.colour, '#123456')
    ui.changeKind('kind-set', {...ui.kindDraft, label: 'Notes $(literal)', paths: 'docs/\n--literal path\n'})
    assert.deepEqual(plain(ui.calls), [['kind-set', ['notes', '--label=Notes $(literal)', '--colour=#123456',
        '--path=docs/', '--path=--literal path', '--ext=.txt'], 'kind-change']])
    ui.changeKind('kind-remove', ui.kindDraft)
    assert.equal(ui.calls.length, 1, 'busy editor must not queue a duplicate mutation')
})

test('save failures retain the draft and place the CLI message at its field', () => {
    const ui = panel()
    ui.editKind(kind)
    ui.kindsBusy = true
    ui.handleReply(reply('kind-set', null, {ok: false, code: 'config_invalid', message: 'kind extensions must be dotted extensions'}))
    assert.equal(ui.page, 'kind-editor')
    assert.equal(ui.kindDraft.id, 'notes')
    assert.equal(ui.kindsBusy, false)
    assert.equal(ui.kindsErrorField, 'extensions')
    assert.equal(ui.kindsError, 'kind extensions must be dotted extensions')
    for (const [message, field] of [['kind id must match', 'id'], ['kind label must be non-empty text', 'label'],
        ['kind colour must be a theme name or #rrggbb', 'colour'], ['kind match paths must be a list of strings', 'paths'],
        ['The backend request timed out.', 'save']]) {
        assert.equal(bridge.kindErrorField(message), field)
    }
})

test('add rejects an existing id and empty match; successful mutations reload table and index', () => {
    const ui = panel()
    ui.kindTable = [kind]
    ui.editKind(null)
    ui.changeKind('kind-set', {...ui.kindDraft, id: 'notes', extensions: '.txt'})
    assert.equal(ui.kindsErrorField, 'id')
    assert.equal(ui.calls.length, 0)
    ui.changeKind('kind-set', {...ui.kindDraft, id: '--bad', extensions: '.txt'})
    assert.equal(ui.kindsErrorField, 'id')
    assert.equal(ui.calls.length, 0)
    ui.changeKind('kind-set', {...ui.kindDraft, id: 'other'})
    assert.equal(ui.kindsErrorField, 'paths')
    assert.equal(ui.calls.length, 0)
    ui.changeKind('kind-set', {...ui.kindDraft, id: 'other', label: 'Other', extensions: '.txt'})
    ui.handleReply(reply('kind-set', {config: {roots: []}}))
    assert.equal(ui.page, 'kinds')
    assert.equal(ui.kindsBusy, false)
    assert.deepEqual(plain(ui.calls.slice(1)), [['kinds', [], 'kinds'], ['refresh']])
    ui.selectedKinds = ['notes', 'removed']
    ui.handleReply(reply('kinds', {kinds: [kind]}))
    assert.deepEqual(plain(ui.selectedKinds), ['notes'])
    ui.handleReply(reply('index', null, {ok: false, code: 'no_roots'}))
    assert.equal(ui.page, 'kinds', 'kind editing is available before adding roots')
    assert.deepEqual(plain(ui.kindTable), [kind])
    assert.ok(!ui.calls.some(call => call[0] === 'roots'))
    ui.changeKind('kind-remove', kind)
    assert.deepEqual(plain(ui.calls.at(-1)), ['kind-remove', ['notes'], 'kind-change'])
    ui.handleReply(reply('kind-remove', {config: {roots: []}}))
    assert.deepEqual(plain(ui.calls.slice(-2)), [['kinds', [], 'kinds'], ['refresh']])
})

test('theme names are parsed without hard-coded runtime colours', () => {
    assert.deepEqual(plain(bridge.themeColours('blue = "#123456"\nbright_green = \'#ABCDEF\'\nblue = "bad"\nbackground = "#000000"')),
        {blue: '#123456', bright_green: '#ABCDEF'})
})

test('editor argv relabels, recolours, tracks a new type, clears either list, resets and removes through the CLI', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kind-editor-'))
    try {
        const env = {...process.env, HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_CACHE_HOME: path.join(temp, 'cache')}
        const cli = (command, args = []) => {
            const result = JSON.parse(execFileSync('python3', ['-B', path.join(root, 'atlas.py'), command, ...args, '--json'], {env, encoding: 'utf8'}))
            assert.equal(result.ok, true, result.message)
            return result.data
        }
        const fixture = path.join(temp, 'fixture')
        fs.cpSync(path.join(root, 'tests/fixtures/index/kinds'), fixture, {recursive: true})
        cli('root-add', [fixture, '--name=fixture'])
        const draft = {id: 'notes', label: 'Text notes', colour: '#123456', paths: '', extensions: '.txt', builtin: false}
        cli('kind-set', plain(bridge.kindArguments(draft).arguments))
        let index = cli('index').index
        assert.equal(index.files.find(file => file.path === 'notes.txt').kind, 'notes')
        assert.equal(index.kinds.find(item => item.id === 'notes').label, 'Text notes')
        assert.equal(index.kinds.find(item => item.id === 'notes').colour, '#123456')
        cli('kind-set', plain(bridge.kindArguments({...draft, paths: 'notes.txt', extensions: ''}).arguments))
        assert.deepEqual(cli('kinds').kinds[0].match, {paths: ['notes.txt'], extensions: []})
        cli('kind-remove', ['notes'])
        assert.ok(!cli('index').index.files.some(file => file.path === 'notes.txt'))
        const builtin = cli('kinds').kinds.find(item => item.id === 'doc')
        cli('kind-set', plain(bridge.kindArguments({id: 'doc', label: 'My documents', colour: 'red', builtin: true,
            paths: '', extensions: '.md'}).arguments))
        assert.equal(cli('kinds').kinds[0].label, 'My documents')
        cli('kind-set', plain(bridge.kindArguments({id: 'doc', label: 'All files', colour: 'blue', builtin: true,
            paths: '', extensions: ''}).arguments))
        assert.deepEqual(cli('kinds').kinds[0].match, {paths: ['*'], extensions: []})
        cli('kind-remove', ['doc'])
        assert.deepEqual(cli('kinds').kinds.find(item => item.id === 'doc'), builtin)
    } finally {
        fs.rmSync(temp, {recursive: true, force: true})
    }
})
