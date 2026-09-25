/* Pure index shaping shared by the native panel and Node fixture tests. */

var REFERENCE_STYLES = ["markdown", "wikilink", "path", "import", "impact"]

function fileKey(root, path) {
    return JSON.stringify([root, path])
}

function contains(values, value) {
    return !values || values.length === 0 || values.indexOf(value) !== -1
}

function rootCounts(index) {
    var counts = {}
    var roots = index && index.roots ? index.roots : []
    var files = index && index.files ? index.files : []
    for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1)
        counts[roots[rootIndex].name] = 0
    for (var fileIndex = 0; fileIndex < files.length; fileIndex += 1)
        counts[files[fileIndex].root] = (counts[files[fileIndex].root] || 0) + 1
    return counts
}

function rootOptions(index) {
    var counts = rootCounts(index)
    return (index && index.roots ? index.roots : []).map(function (root) {
        return { name: root.name, count: counts[root.name] || 0 }
    })
}

function kindCounts(files, kinds) {
    var counts = {}
    for (var kindIndex = 0; kindIndex < (kinds || []).length; kindIndex += 1)
        counts[kinds[kindIndex].id] = 0
    for (var fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        var kind = files[fileIndex].kind
        counts[kind] = (counts[kind] || 0) + 1
    }
    return counts
}

function kindLabel(kinds, id) {
    var kind = (kinds || []).filter(function (item) { return item.id === id })[0]
    return kind ? kind.label : id
}

function kindRule(kind) {
    var match = kind.match || {}
    return (match.paths || []).join(", ") || "Any path"
}

function kindTypes(kind) {
    return ((kind.match || {}).extensions || []).join(", ") || "Any file type"
}

function kindOptions(index) {
    var counts = kindCounts(index.files || [], index.kinds)
    return (index.kinds || []).map(function (kind) {
        return Object.assign({}, kind, { count: counts[kind.id] || 0 })
    })
}

function findingCounts(files) {
    var counts = { orphans: 0, dangling: 0, stale: 0 }
    for (var fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        var file = files[fileIndex]
        if (file.orphan)
            counts.orphans += 1
        if (file.dangling > 0)
            counts.dangling += 1
        if (file.stale)
            counts.stale += 1
    }
    return counts
}

function unavailableLabels(unavailable) {
    var labels = []
    for (var itemIndex = 0; itemIndex < (unavailable || []).length; itemIndex += 1) {
        var item = unavailable[itemIndex]
        var label = item.reason === "root missing" ? item.root + ": root missing" : "stale analysis unavailable in " + item.root + ": " + item.reason
        if (labels.indexOf(label) === -1)
            labels.push(label)
    }
    return labels
}

function searchKeys(matches) {
    var keys = {}
    matches = matches || []
    for (var matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
        var match = matches[matchIndex]
        if (match.file)
            keys[fileKey(match.file.root, match.file.path)] = true
    }
    return keys
}

function matchesFindings(file, findings) {
    if (!findings)
        return true
    if (findings.orphans && !file.orphan)
        return false
    if (findings.dangling && !(file.dangling > 0))
        return false
    if (findings.stale && !file.stale)
        return false
    return true
}

function filterFiles(index, filters, matches) {
    var files = index && index.files ? index.files : []
    filters = filters || {}
    var query = (filters.query || "").trim().toLocaleLowerCase()
    var matched = searchKeys(matches)
    return files.filter(function (file) {
        if (!contains(filters.roots, file.root) || !contains(filters.kinds, file.kind))
            return false
        if (!matchesFindings(file, filters.findings))
            return false
        if (!query)
            return true
        var localMatch = (file.path + "\n" + file.title).toLocaleLowerCase().indexOf(query) !== -1
        return localMatch || matched[fileKey(file.root, file.path)] === true
    })
}

function filterMatches(matches, files) {
    var visible = {}
    for (var fileIndex = 0; fileIndex < files.length; fileIndex += 1)
        visible[fileKey(files[fileIndex].root, files[fileIndex].path)] = true
    return (matches || []).filter(function (match) {
        return match.file && visible[fileKey(match.file.root, match.file.path)] === true
    })
}

function groupByStyle(references) {
    var groups = []
    for (var styleIndex = 0; styleIndex < REFERENCE_STYLES.length; styleIndex += 1) {
        var style = REFERENCE_STYLES[styleIndex]
        var items = references.filter(function (reference) {
            return reference.style === style
        })
        if (items.length)
            groups.push({ style: style, count: items.length, references: items })
    }
    return groups
}

function referenceGroups(index, root, path) {
    var references = index && index.references ? index.references : []
    var inbound = []
    var outbound = []
    for (var referenceIndex = 0; referenceIndex < references.length; referenceIndex += 1) {
        var reference = references[referenceIndex]
        if (reference.to && reference.to.root === root && reference.to.path === path)
            inbound.push(reference)
        if (reference.from && reference.from.root === root && reference.from.path === path)
            outbound.push(reference)
    }
    return { inbound: groupByStyle(inbound), outbound: groupByStyle(outbound) }
}

function selectedCost(costRows, file, roots) {
    if (!file || file.kind !== "instruction")
        return []
    var registeredRoot = (roots || []).find(function (root) {
        return root.name === file.root
    })
    var absolutePath = registeredRoot
        ? registeredRoot.path + (registeredRoot.path.endsWith("/") ? "" : "/") + file.path
        : null
    return (costRows || []).filter(function (row) {
        if (row.root !== file.root)
            return false
        return (row.startup || []).some(function (entry) {
            return entry.path === file.path || entry.path === absolutePath
        })
    })
}

function facts(index, root, path, costRows) {
    var files = index && index.files ? index.files : []
    var file = null
    for (var fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        if (files[fileIndex].root === root && files[fileIndex].path === path) {
            file = files[fileIndex]
            break
        }
    }
    if (!file)
        return null
    var groups = referenceGroups(index, root, path)
    return {
        file: file,
        inboundGroups: groups.inbound,
        outboundGroups: groups.outbound,
        stale: file.stale,
        cost: selectedCost(costRows, file, index.roots)
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        REFERENCE_STYLES: REFERENCE_STYLES,
        fileKey: fileKey,
        rootCounts: rootCounts,
        rootOptions: rootOptions,
        kindCounts: kindCounts,
        kindLabel: kindLabel,
        kindRule: kindRule,
        kindTypes: kindTypes,
        kindOptions: kindOptions,
        findingCounts: findingCounts,
        unavailableLabels: unavailableLabels,
        filterFiles: filterFiles,
        filterMatches: filterMatches,
        groupByStyle: groupByStyle,
        referenceGroups: referenceGroups,
        selectedCost: selectedCost,
        facts: facts
    }
}
