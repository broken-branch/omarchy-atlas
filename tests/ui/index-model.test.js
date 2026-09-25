const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const model = require("../../ui/IndexModel.js")

const fixtureDirectory = path.join(__dirname, "../fixtures/ui")
const index = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "index.json"), "utf8"))
const search = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "search.json"), "utf8"))
const cost = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "cost.json"), "utf8"))

test("counts roots, kinds, and findings from contract-shaped files", () => {
    assert.deepEqual(model.rootCounts(index), { alpha: 3, beta: 2 })
    assert.deepEqual(model.rootOptions(index), [
        { name: "alpha", count: 3 },
        { name: "beta", count: 2 }
    ])
    assert.equal(model.kindCounts(index.files).doc, 2)
    const kinds = [
        {id: "text", label: "Notes", colour: "#123456", match: {paths: [], extensions: [".txt"]}},
        {id: "doc", label: "Project docs", colour: "blue", match: {paths: [], extensions: [".md"]}}
    ]
    assert.equal(model.kindCounts(index.files, kinds).text, 0)
    assert.deepEqual(model.kindOptions({...index, kinds}), [
        {...kinds[0], count: 0}, {...kinds[1], count: 2}
    ])
    assert.equal(model.kindLabel(kinds, "doc"), "Project docs")
    assert.equal(model.kindLabel(kinds, "missing"), "missing")
    assert.equal(model.kindRule(kinds[0]), "Any path")
    assert.equal(model.kindRule({match: {paths: ["docs/", "*.txt"]}}), "docs/, *.txt")
    assert.equal(model.kindTypes(kinds[0]), ".txt")
    assert.equal(model.kindTypes({match: {extensions: []}}), "Any file type")
    assert.deepEqual(model.kindOptions({files: []}), [])
    assert.deepEqual(model.findingCounts(index.files), { orphans: 1, dangling: 2, stale: 1 })
})

test("filters roots, kinds, combined findings, and backend content matches", () => {
    assert.deepEqual(
        model.filterFiles(index, { roots: ["alpha"], kinds: ["doc"], findings: { stale: true } }, []),
        [index.files[1]]
    )
    assert.deepEqual(
        model.filterFiles(index, { findings: { dangling: true, stale: true } }, []),
        [index.files[1]]
    )
    assert.deepEqual(model.filterFiles(index, { query: "needle" }, search.matches), [index.files[1]])
    assert.deepEqual(model.filterFiles(index, { query: "recover" }, []), [index.files[4]])
})

test("filters content matches to the visible file identities", () => {
    const visible = model.filterFiles(index, { roots: ["beta"], query: "needle" }, search.matches)
    assert.deepEqual(model.filterMatches(search.matches, visible), [])
})

test("recent search rows follow newest file order and retain line order within each file", () => {
    const now = Date.parse("2026-09-25T12:00:00Z")
    const file = (path, minutes) => ({root: "alpha", path, title: path,
        modified: new Date(now - minutes * 60000).toISOString(), open: false})
    const older = file("old.md", 40)
    const newer = file("new.md", 5)
    const match = (file, line) => ({file, line, text: "needle"})
    const matches = [match(older, 2), match(newer, 4), match(older, 5), match(newer, 7)]
    const visible = model.filterFiles({files: [older, newer]},
        {query: "needle", findings: {recent: true}, now}, matches)
    assert.deepEqual(visible.map(item => item.path), ["new.md", "old.md"])
    assert.deepEqual(model.filterMatches(matches, visible, true).map(item => [item.file.path, item.line]),
        [["new.md", 4], ["new.md", 7], ["old.md", 2], ["old.md", 5]])
    assert.deepEqual(model.filterMatches(matches, visible).map(item => [item.file.path, item.line]),
        [["old.md", 2], ["new.md", 4], ["old.md", 5], ["new.md", 7]])
})

test("uses structured root and path identities", () => {
    assert.notEqual(model.fileKey("a/b", "c.md"), model.fileKey("a", "b/c.md"))
})

test("groups selected-file references by direction and style", () => {
    const groups = model.referenceGroups(index, "alpha", "docs/guide.md")
    assert.deepEqual(groups.inbound.map(group => [group.style, group.count]), [
        ["markdown", 1],
        ["impact", 1]
    ])
    assert.deepEqual(groups.outbound.map(group => [group.style, group.count]), [["wikilink", 1]])
    assert.equal(groups.outbound[0].references[0].resolved, false)
})

test("returns stale and instruction-cost facts only for the selected identity", () => {
    const guide = model.facts(index, "alpha", "docs/guide.md", cost.roots)
    assert.equal(guide.stale.rule, "impact.yml#1")
    assert.deepEqual(guide.cost, [])

    const instruction = model.facts(index, "alpha", "AGENTS.md", cost.roots)
    // AGENTS.md loads at startup for Claude (imported) and Codex; beta's AGENTS.md is another file.
    assert.deepEqual(instruction.cost.map(row => [row.agent, row.startupTokensApprox]), [["claude", 103], ["codex", 120]])
    assert.equal(model.facts(index, "alpha", "missing.md", cost.roots), null)
})

test("names each unavailable entry by its root and reason, once", () => {
    assert.deepEqual(model.unavailableLabels(index.unavailable), ["stale analysis unavailable in beta: impact map absent"])
    assert.deepEqual(model.unavailableLabels([
        { root: "notes", reason: "root missing" },
        { root: "alpha", path: "nested/README.md", reason: "git unavailable" },
        { root: "beta", reason: "impact map unreadable" },
        { root: "alpha", path: "README.md", reason: "no usable source timestamp" },
        { root: "alpha", path: "docs/guide.md", reason: "no usable source timestamp" }
    ]), ["notes: root missing", "alpha:nested/README.md: git unavailable", "stale analysis unavailable in beta: impact map unreadable", "stale analysis unavailable in alpha: no usable source timestamp"])
    assert.deepEqual(model.unavailableLabels([]), [])
})

test("recency respects the 30 minute and 24 hour boundaries, with open taking priority", () => {
    const now = Date.parse("2026-09-25T12:00:00Z")
    const file = seconds => ({modified: new Date(now - seconds * 1000).toISOString(), open: false})
    assert.equal(model.recency(file(29 * 60 + 59), now), "red")
    assert.equal(model.recency(file(30 * 60 + 1), now), "orange")
    assert.equal(model.recency(file(24 * 3600), now), "orange")
    assert.equal(model.recency(file(24 * 3600 + 1), now), "")
    assert.equal(model.recency({...file(24 * 3600 + 1), open: true}, now), "red")
    assert.equal(model.recency(file(-3600), now), "red")
    assert.deepEqual(model.recencyCounts([file(-3600)], now), {recent: 1, red: 1})
    assert.equal(model.relativeTime(file(4 * 60), now), "edited 4 min ago")
    assert.equal(model.relativeTime(file(5 * 3600), now), "edited 5 h ago")
    assert.equal(model.relativeTime({...file(5 * 3600), open: true}, now), "open in editor")
    assert.equal(model.recencyDescription(file(4 * 60), now), "edited within 30 min")
    assert.equal(model.recencyDescription(file(5 * 3600), now), "edited within 24 h")
    assert.equal(model.recencyDescription({...file(5 * 3600), open: true}, now), "open in editor")
    assert.equal(model.recencyText({...file(5 * 3600), open: true}, now), "open in editor")
    assert.equal(model.recencyText(file(4 * 60), now), "edited 4 min ago · edited within 30 min")
    assert.equal(model.barRecency({red: 2}), "2 open in editor or edited within 30 min")
    assert.equal(model.barRecency({red: 0}), "")
})

test("retry chooses the failed request for both button and keyboard paths", () => {
    assert.equal(model.failureCommand("", "search failed", ""), "search")
    assert.equal(model.failureCommand("", "", "cost failed"), "cost")
    assert.equal(model.failureCommand("index failed", "search failed", ""), "index")
    assert.equal(model.failureCommand("", "", ""), "index")
})

test("Escape clears a failed search and leaves no error to retry", () => {
    assert.deepEqual(model.clearedSearch(), {query: "", matches: [], error: ""})
})

test("warm and hot colours always resolve to a visible theme or urgent colour", () => {
    const urgent = "#ff4444"
    assert.equal(model.recencyColour({orange: "#ff9900", yellow: "#ffff00"}, urgent, true), "#ff9900")
    assert.equal(model.recencyColour({red: "#ff0000", yellow: "#ffff00"}, urgent, true), "#ff7f00")
    assert.equal(model.recencyColour({}, urgent, true), urgent)
    assert.equal(model.recencyColour({orange: "#000000"}, urgent, true), urgent)
    assert.equal(model.recencyColour({red: "#ee0000"}, urgent, false), "#ee0000")
    assert.equal(model.recencyColour({}, urgent, false), urgent)
})

test("keyboard advances through distinct content hits in one file", () => {
    const file = {root: "alpha", path: "guide.md"}
    const rows = [{file, line: 2}, {file, line: 5}]
    assert.equal(model.nextRowIndex(rows, -1, 1), 0)
    assert.equal(model.nextRowIndex(rows, 0, 1), 1)
    assert.equal(model.nextRowIndex(rows, 1, -1), 0)
    assert.equal(model.nextRowIndex(rows, 1, 1), 1)
})

test("recent counts and list include open files older than a day", () => {
    const now = Date.parse("2026-09-25T12:00:00Z")
    const file = (path, seconds, open = false) => ({root: "alpha", path, title: path,
        modified: new Date(now - seconds * 1000).toISOString(), open})
    const files = [file("older.md", 24 * 3600 + 1, true), file("hours.md", 5 * 3600),
        file("minutes.md", 4 * 60), file("day.md", 24 * 3600)]
    assert.deepEqual(model.recencyCounts(files, now), {recent: 4, red: 2})
    assert.deepEqual(model.filterFiles({files}, {findings: {recent: true}, now}).map(item => item.path),
        ["minutes.md", "hours.md", "day.md", "older.md"])
    assert.deepEqual(files.map(item => item.path), ["older.md", "hours.md", "minutes.md", "day.md"])
})
