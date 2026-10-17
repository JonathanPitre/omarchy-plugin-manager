import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const modelSource = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(modelSource + `
  return { starSlugFor,
    starToggleCommand: typeof starToggleCommand === "function" ? starToggleCommand : undefined,
    parseStarResult: typeof parseStarResult === "function" ? parseStarResult : undefined }
`)()
const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")

function qmlFunction(name) {
  const start = store.indexOf(`  function ${name}(`)
  assert.notEqual(start, -1, `missing ${name}`)
  return store.slice(start, store.indexOf("\n  }", start) + 4)
}

function starStore() {
  const effects = []
  const later = []
  const state = {
    Model, starBusy: false, pendingStarRequest: null,
    starExited: false, starOutputDone: false, starCode: -1,
    starOutput: "", starStarted: false, starStartSettled: false,
    starProc: { command: [], running: false },
    Qt: { resolvedUrl: () => "file:///tmp/plugin%20manager/helpers/github_star.py",
      callLater: callback => later.push(callback) },
    setStatus: (...args) => effects.push(["status", ...args]),
    flashStatus: (...args) => effects.push(["status", ...args]),
    bumpCatalogCount: (...args) => effects.push(["count", ...args]),
    browseUrlRequested: url => effects.push(["browser", url]),
  }
  const names = ["toggleStar", "finishStar", "settleStarStart"]
  Object.assign(state, new Function("state", `with (state) {
    ${names.map(qmlFunction).join("\n")}
    return { ${names.join(", ")} }
  }`)(state))
  const process = store.slice(store.indexOf("    id: starProc"), store.indexOf("    id: barMoveProc"))
  const run = code => new Function("root", "Qt", "running", code)(state, state.Qt, state.starProc.running)
  const events = {
    started() { run(process.match(/onStarted: \{([\s\S]*?)\n    \}/)[1]) },
    output(text) { new Function("root", "text", process.match(/onStreamFinished: \{([\s\S]*?)\n      \}/)[1])(state, text) },
    exited(code) { new Function("root", "exitCode", process.match(/onExited: function\(exitCode\) \{([\s\S]*?)\n    \}/)[1])(state, code) },
    stopped() {
      state.starProc.running = false
      run(process.match(/onRunningChanged: ([^\n]+)/)[1])
      while (later.length) later.shift()()
    },
  }
  return { state, effects, events }
}

test("the star command invokes the isolated helper with a validated slug", () => {
  assert.deepEqual(Model.starToggleCommand?.("/tmp/plugin manager/helpers/github_star.py", "Acme/thing"),
    ["/usr/bin/python3", "-I", "-S", "/tmp/plugin manager/helpers/github_star.py", "Acme/thing"])
  for (const slug of ["", null, "acme/../thing", "acme/..", "-acme/repo", "acme/repo?x", "acme/repo\n"]) {
    assert.deepEqual(Model.starToggleCommand?.("/tmp/helper.py", slug), [], String(slug))
  }
  assert.deepEqual(Model.starToggleCommand?.("", "acme/thing"), [])
})

test("only known helper results authorize a count change", () => {
  for (const outcome of [{ kind: "changed", starred: true }, { kind: "changed", starred: false },
    { kind: "fallback" }, { kind: "failed" }]) {
    assert.deepEqual(Model.parseStarResult?.(JSON.stringify(outcome), 0), outcome)
  }
  for (const output of ["", "bad JSON", "null", "[]", '{}', '{"kind":"changed"}',
    '{"kind":"changed","starred":1}', '{"kind":"other"}',
    '{"kind":"changed","starred":true,"token":"secret"}', '{"kind":"fallback","starred":true}']) {
    assert.deepEqual(Model.parseStarResult?.(output, 0), { kind: "failed" }, output)
  }
  assert.deepEqual(Model.parseStarResult?.('{"kind":"changed","starred":true}', 1), { kind: "failed" })
})

test("duplicate clicks are rejected and completion uses the captured repository and name", () => {
  const { state, effects, events } = starStore()
  const entry = { id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" }
  assert.equal(state.toggleStar(entry), true)
  assert.deepEqual(state.starProc.command, ["/usr/bin/python3", "-I", "-S",
    "/tmp/plugin manager/helpers/github_star.py", "acme/thing"])
  assert.equal(state.toggleStar({ ...entry, repo: "https://github.com/other/repo" }), false)
  Object.assign(entry, { id: "other.repo", name: "Other", repo: "https://github.com/other/repo" })
  events.started()
  events.exited(0)
  events.output('{"kind":"changed","starred":true}')
  events.stopped()
  assert.equal(state.starBusy, false)
  assert.deepEqual(effects.slice(1), [["count", "acme.thing", 1], ["status", "Starred Thing", false]])
  assert.equal(state.pendingStarRequest, null)
})

test("all started, output, and exit callback orders retain busy until settlement", () => {
  for (const order of [["started", "output", "exited"], ["started", "exited", "output"],
    ["output", "started", "exited"], ["output", "exited", "started"],
    ["exited", "started", "output"], ["exited", "output", "started"]]) {
    const { state, effects, events } = starStore()
    state.toggleStar({ id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" })
    for (const event of order) {
      events[event](event === "output" ? '{"kind":"changed","starred":false}' : 0)
      assert.equal(state.starBusy, true, order.join(","))
      assert.equal(effects.length, 1)
    }
    events.stopped()
    assert.equal(state.starBusy, false)
    assert.deepEqual(effects.slice(1), [["count", "acme.thing", -1],
      ["status", "Removed the star from Thing", false]])
    state.finishStar()
    assert.equal(effects.length, 3, "settlement must not apply the count twice")
  }
})

test("exit and idle still wait for stdout before applying a successful result", () => {
  const { state, effects, events } = starStore()
  state.toggleStar({ id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" })
  events.started()
  events.exited(0)
  events.stopped()
  assert.equal(state.starBusy, true)
  assert.equal(effects.length, 1)
  events.output('{"kind":"changed","starred":true}')
  assert.equal(state.starBusy, false)
  assert.equal(effects[1][0], "count")
})

test("fallback opens the captured repository without changing counts", () => {
  const { state, effects, events } = starStore()
  const entry = { id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" }
  state.toggleStar(entry)
  entry.repo = "https://github.com/other/repo"
  events.started()
  events.output('{"kind":"fallback"}')
  events.exited(0)
  events.stopped()
  assert.deepEqual(effects.slice(1), [["browser", "https://github.com/acme/thing"]])
})

test("a helper that cannot start falls back after the deferred start check", () => {
  const { state, effects, events } = starStore()
  state.toggleStar({ id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" })
  events.stopped()
  assert.equal(state.starBusy, false)
  assert.deepEqual(effects.slice(1), [["browser", "https://github.com/acme/thing"]])
})

test("failed writes and malformed helper output leave the count unchanged", () => {
  for (const [output, code] of [['{"kind":"failed"}', 0], ["bad JSON", 0],
    ['{"kind":"changed","starred":true}', 1]]) {
    const { state, effects, events } = starStore()
    state.toggleStar({ id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" })
    events.started()
    events.output(output)
    events.exited(code)
    events.stopped()
    assert.equal(state.starBusy, false)
    assert.deepEqual(effects.slice(1), [["status", "Could not change the star for Thing", true]])
  }
})

test("each click checks anew after a completed click and rejects an invalid repository", () => {
  const { state, effects, events } = starStore()
  const entry = { id: "acme.thing", name: "Thing", repo: "https://github.com/acme/thing" }
  assert.equal(state.toggleStar({ ...entry, repo: "https://github.com/acme/thing/issues" }), false)
  for (const starred of [true, false]) {
    assert.equal(state.toggleStar(entry), true)
    assert.equal(state.starStarted, false)
    assert.equal(state.starOutput, "")
    events.started()
    events.output(JSON.stringify({ kind: "changed", starred }))
    events.exited(0)
    events.stopped()
  }
  assert.deepEqual(effects.filter(effect => effect[0] === "count"),
    [["count", "acme.thing", 1], ["count", "acme.thing", -1]])
})
