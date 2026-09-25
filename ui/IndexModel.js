var REFERENCE_STYLES = ["markdown", "wikilink", "path", "import", "impact"]
var HALF_HOUR = 30 * 60 * 1000
var DAY = 24 * 60 * 60 * 1000

function modifiedMillis(file) {
    var value = file && file.modified ? Date.parse(file.modified) : NaN
    return isFinite(value) ? value : NaN
}

function recency(file, now) {
    if (file && file.open === true)
        return "red"
    var age = now - modifiedMillis(file)
    if (!isFinite(age))
        return ""
    if (age <= HALF_HOUR)
        return "red"
    return age <= DAY ? "orange" : ""
}

function recencyCounts(files, now) {
    var counts = { recent: 0, red: 0 }
    for (var i = 0; i < files.length; i += 1) {
        var state = recency(files[i], now)
        if (state === "red")
            counts.red += 1
        if (recentlyEdited(files[i], now))
            counts.recent += 1
    }
    return counts
}

function recentlyEdited(file, now) {
    var age = now - modifiedMillis(file)
    return (file && file.open === true) || (isFinite(age) && age <= DAY)
}

function relativeTime(file, now) {
    if (file && file.open === true)
        return "open in editor"
    var age = now - modifiedMillis(file)
    if (!isFinite(age))
        return ""
    if (age < 0)
        return "edited just now"
    if (age < 60000)
        return "edited just now"
    if (age < 3600000)
        return "edited " + Math.floor(age / 60000) + " min ago"
    if (age < DAY)
        return "edited " + Math.floor(age / 3600000) + " h ago"
    return "edited " + Math.floor(age / DAY) + " d ago"
}

function recencyDescription(file, now) {
    if (file && file.open === true)
        return "open in editor"
    var state = recency(file, now)
    return state === "red" ? "edited within 30 min" : state === "orange" ? "edited within 24 h" : ""
}

function recencyText(file, now) {
    var time = relativeTime(file, now)
    var description = recencyDescription(file, now)
    return time === description ? time : [time, description].filter(Boolean).join(" · ")
}

function failureCommand(refreshError, searchError, costError) {
    return refreshError ? "index" : searchError ? "search" : costError ? "cost" : "index"
}

function clearedSearch() {
    return { query: "", matches: [], error: "" }
}

function barRecency(counts) {
    return counts.red ? counts.red + " open in editor or edited within 30 min" : ""
}

function recencyColour(colours, fallback, warm) {
    var mixed = ""
    if (warm && /^#[0-9a-f]{6}$/i.test(colours.red || "") && /^#[0-9a-f]{6}$/i.test(colours.yellow || "")) {
        mixed = "#"
        for (var offset = 1; offset < 7; offset += 2) {
            var channel = Math.floor((parseInt(colours.red.slice(offset, offset + 2), 16)
                + parseInt(colours.yellow.slice(offset, offset + 2), 16)) / 2).toString(16)
            mixed += ("0" + channel).slice(-2)
        }
    }
    var candidates = warm ? [colours.orange, mixed, colours.yellow] : [colours.red]
    candidates.push(fallback)
    for (var i = 0; i < candidates.length; i += 1) {
        var value = candidates[i]
        if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && value.toLowerCase() !== "#000000")
            return value
    }
    return fallback
}

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
        var label = item.reason === "root missing" ? item.root + ": root missing"
            : item.reason === "git unavailable" ? item.root + ":" + item.path + ": git unavailable"
            : "stale analysis unavailable in " + item.root + ": " + item.reason
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

function matchesFindings(file, findings, now) {
    if (!findings)
        return true
    if (findings.orphans && !file.orphan)
        return false
    if (findings.dangling && !(file.dangling > 0))
        return false
    if (findings.stale && !file.stale)
        return false
    if (findings.recent && !recentlyEdited(file, now))
        return false
    return true
}

function filterFiles(index, filters, matches) {
    var files = index && index.files ? index.files : []
    filters = filters || {}
    var query = (filters.query || "").trim().toLocaleLowerCase()
    var matched = searchKeys(matches)
    var visible = files.filter(function (file) {
        if (!contains(filters.roots, file.root) || !contains(filters.kinds, file.kind))
            return false
        if (!matchesFindings(file, filters.findings, filters.now))
            return false
        if (!query)
            return true
        var localMatch = (file.path + "\n" + file.title).toLocaleLowerCase().indexOf(query) !== -1
        return localMatch || matched[fileKey(file.root, file.path)] === true
    })
    if (filters.findings && filters.findings.recent)
        visible.sort(function (a, b) {
            return modifiedMillis(b) - modifiedMillis(a) || fileKey(a.root, a.path).localeCompare(fileKey(b.root, b.path))
        })
    return visible
}

function filterMatches(matches, files, newestFirst) {
    var visible = {}
    for (var fileIndex = 0; fileIndex < files.length; fileIndex += 1)
        visible[fileKey(files[fileIndex].root, files[fileIndex].path)] = fileIndex
    var filtered = (matches || []).filter(function (match) {
        return match.file && visible[fileKey(match.file.root, match.file.path)] !== undefined
    })
    if (!newestFirst)
        return filtered
    return filtered.map(function (match, position) {
        return { match: match, position: position }
    }).sort(function (a, b) {
        return visible[fileKey(a.match.file.root, a.match.file.path)] - visible[fileKey(b.match.file.root, b.match.file.path)]
            || a.position - b.position
    }).map(function (item) { return item.match })
}

function nextRowIndex(rows, current, offset) {
    if (!rows.length || !offset)
        return -1
    return current < 0 ? (offset < 0 ? rows.length - 1 : 0)
        : Math.max(0, Math.min(rows.length - 1, current + offset))
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
        recency: recency,
        recencyCounts: recencyCounts,
        relativeTime: relativeTime,
        recencyDescription: recencyDescription,
        recencyText: recencyText,
        failureCommand: failureCommand,
        clearedSearch: clearedSearch,
        barRecency: barRecency,
        recencyColour: recencyColour,
        unavailableLabels: unavailableLabels,
        filterFiles: filterFiles,
        filterMatches: filterMatches,
        nextRowIndex: nextRowIndex,
        groupByStyle: groupByStyle,
        referenceGroups: referenceGroups,
        selectedCost: selectedCost,
        facts: facts
    }
}
