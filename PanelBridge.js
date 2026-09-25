.pragma library

function localPath(url) {
    var value = String(url)
    if (value.indexOf("file://") === 0)
        value = value.slice(7)
    return decodeURIComponent(value)
}

function parseReply(output, command) {
    var framed = String(output)
    if (framed.length < 2 || framed[framed.length - 1] !== "\n")
        return { valid: false, message: "The backend returned invalid framing." }

    var body = framed.slice(0, -1)
    if (body.trim() !== body || body.indexOf("\n") !== -1)
        return { valid: false, message: "The backend returned invalid framing." }
    try {
        var reply = JSON.parse(body)
        if (!reply || Array.isArray(reply) || reply.version !== 1
                || reply.command !== command || typeof reply.ok !== "boolean")
            return { valid: false, message: "The backend returned an invalid reply." }
        return { valid: true, reply: reply }
    } catch (error) {
        return { valid: false, message: "The backend returned invalid JSON." }
    }
}

function indexData(data) {
    return data && data.index && typeof data.index === "object" ? data.index : null
}

function searchData(data) {
    return data && Array.isArray(data.matches) ? data.matches : []
}

function requestTimeout(command) {
    return command === "index" ? 30000 : 10000
}

function ageText(generatedAt) {
    return generatedAt ? String(generatedAt) : "an unknown time"
}

function parseMounts(output) {
    try {
        var data = JSON.parse(String(output))
        if (!data || !Array.isArray(data.filesystems))
            return { valid: false, message: "findmnt returned no filesystem list." }
        var drives = []
        data.filesystems.forEach(function (mount) {
            if (!mount || typeof mount.target !== "string" || mount.target[0] !== "/")
                throw new Error("Invalid mount target")
            if (!drives.some(function (drive) { return drive.target === mount.target }))
                drives.push({ target: mount.target, source: String(mount.source || ""), fstype: String(mount.fstype || "") })
        })
        return { valid: true, drives: drives }
    } catch (error) {
        return { valid: false, message: "findmnt returned invalid mount data." }
    }
}

var KIND_COLOURS = ["red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown",
    "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue", "bright_magenta",
    "muted", "accent", "foreground"]

function kindArguments(draft) {
    if (!/^[a-z][a-z0-9-]*$/.test(draft.id))
        return { error: "Kind id must match [a-z][a-z0-9-]*.", field: "id" }
    var args = [draft.id, "--label=" + draft.label, "--colour=" + draft.colour]
    var paths = draft.paths.split("\n").map(function (s) { return s.trim() }).filter(Boolean)
    var extensions = draft.extensions.split("\n").map(function (s) { return s.trim() }).filter(Boolean)
    if (!paths.length && !extensions.length) {
        if (!draft.builtin)
            return { error: "A new kind needs at least one path or extension.", field: "paths" }
        // A built-in with both lists cleared still needs a path match.
        paths = ["*"]
    }
    if (!paths.length) args.push("--path=")
    else paths.forEach(function (value) { args.push("--path=" + value) })
    if (!extensions.length) args.push("--ext=")
    else extensions.forEach(function (value) { args.push("--ext=" + value) })
    return { arguments: args }
}

function kindErrorField(message) {
    if (/kind ids?\b/i.test(message)) return "id"
    if (/label/i.test(message)) return "label"
    if (/colour/i.test(message)) return "colour"
    if (/extension/i.test(message)) return "extensions"
    if (/path|match/i.test(message)) return "paths"
    return "save"
}

function themeColours(raw) {
    var colours = {}
    String(raw).split("\n").forEach(function (line) {
        var match = line.match(/^\s*([a-z_]+)\s*=\s*["'](#[0-9a-fA-F]{6})["']/)
        if (match && KIND_COLOURS.indexOf(match[1]) !== -1)
            colours[match[1]] = match[2]
    })
    return colours
}
