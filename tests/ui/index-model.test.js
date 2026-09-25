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
        { root: "alpha", path: "README.md", reason: "no usable source timestamp" },
        { root: "alpha", path: "docs/guide.md", reason: "no usable source timestamp" }
    ]), ["notes: root missing", "stale analysis unavailable in alpha: no usable source timestamp"])
    assert.deepEqual(model.unavailableLabels([]), [])
})
