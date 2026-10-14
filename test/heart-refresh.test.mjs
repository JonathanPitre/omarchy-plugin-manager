import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
const modelSource = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(modelSource + "\nreturn { engagementPluginId, parseHeartResult, heartPostCommand, parseHeartedIds, heartsCachePath, heartsSaveCommand }")()

function callStore(name, state, ...args) {
  const start = source.indexOf(`  function ${name}(`)
  const end = source.indexOf("\n  }", start) + 4
  return new Function("state", "args", `with (state) { ${source.slice(start, end)}; return ${name}(...args) }`)(state, args)
}

test("a repeated heart refreshes a stale zero from the authoritative catalog", () => {
  const entry = { id: "lcd1232.ente-auth", name: "Ente Auth", marketplaceHearts: 0 }
  const state = {
    Model, heartExited: true, heartOutputDone: true, pendingHeartEntry: entry,
    heartBusy: true, heartStarted: true, heartCode: 0,
    heartOutput: '{"recorded":false,"reason":"repeat"}', heartedIds: [],
    flashed: [], flashStatus(text, err) { state.flashed.push([text, err]) },
    saveHeartedId(id) { assert.equal(id, entry.id) },
    bumpCatalogCount() { assert.fail("a repeat must not invent a count increment") },
    loadCatalog(force) { assert.equal(force, true); entry.marketplaceHearts = 1 },
  }
  callStore("finishHeart", state)
  assert.equal(entry.marketplaceHearts, 1)
  assert.deepEqual(state.heartedIds, [entry.id])
  assert.deepEqual(state.flashed, [['"Ente Auth" was already liked.', false]])
})

test("a locally remembered heart still refreshes the count after catalog reload", () => {
  const entry = { id: "lcd1232.ente-auth", name: "Ente Auth", marketplaceHearts: 0 }
  const state = {
    Model, heartBusy: false, isHearted: () => true,
    flashed: [], flashStatus(text, err) { state.flashed.push([text, err]) },
    saveHeartedId() { assert.fail("a remembered heart posts nothing and saves nothing") },
    loadCatalog(force) { assert.equal(force, true); entry.marketplaceHearts = 1 },
  }
  assert.equal(callStore("sendHeart", state, entry), true)
  assert.equal(entry.marketplaceHearts, 1)
  assert.deepEqual(state.flashed, [['"Ente Auth" was already liked.', false]])
})

test("parseHeartedIds keeps only valid ids, deduplicated, in order", () => {
  assert.deepEqual(Model.parseHeartedIds("a.b\nc_d-e\n"), ["a.b", "c_d-e"])
  assert.deepEqual(Model.parseHeartedIds("a.b\na.b\n../x\n__proto__\n\nc\r\n"), ["a.b", "c"])
  assert.deepEqual(Model.parseHeartedIds(""), [])
  assert.deepEqual(Model.parseHeartedIds(null), [])
})

test("heartsCachePath names the shared file or refuses an empty home", () => {
  assert.equal(Model.heartsCachePath("/home/u"), "/home/u/.cache/omarchy-plugin-manager/hearts.log")
  assert.equal(Model.heartsCachePath(""), "")
  assert.equal(Model.heartsCachePath(null), "")
})

test("heartsSaveCommand records one id through the helper, never a shell", () => {
  assert.deepEqual(Model.heartsSaveCommand("/h/hearts.py", "/c/hearts.log", "a.b"),
    ["/usr/bin/python3", "-I", "-S", "/h/hearts.py", "/c/hearts.log", "a.b"])
  assert.deepEqual(Model.heartsSaveCommand("", "/c/hearts.log", "a.b"), [])
  assert.deepEqual(Model.heartsSaveCommand("/h/hearts.py", "", "a.b"), [])
  assert.deepEqual(Model.heartsSaveCommand("/h/hearts.py", "/c/hearts.log", "../x"), [])
})

test("file ids union into memory without duplicates", () => {
  const state = { Model, heartedIds: ["a.b"] }
  callStore("unionHearts", state, "a.b\nc.d\n../x\n\n")
  assert.deepEqual(state.heartedIds, ["a.b", "c.d"])
})

test("a heart the other surface saved never POSTs again", () => {
  const entry = { id: "other.surface.id", name: "Other Surface" }
  const state = {
    Model, heartedIds: [], heartBusy: false,
    isHearted: (id) => state.heartedIds.indexOf(String(id)) >= 0,
    flashed: [], flashStatus(text, err) { state.flashed.push([text, err]) },
    loadCatalog() {},
  }
  state.heartProc = {}
  callStore("unionHearts", state, "other.surface.id\n")
  assert.equal(callStore("sendHeart", state, entry), true)
  assert.deepEqual(state.heartProc, {})
  assert.deepEqual(state.flashed, [['"Other Surface" was already liked.', false]])
})

test("a recorded heart is saved for the other surface", () => {  const entry = { id: "lcd1232.ente-auth", name: "Ente Auth", marketplaceHearts: 0 }
  const saved = []
  const state = {
    Model, heartExited: true, heartOutputDone: true, pendingHeartEntry: entry,
    heartBusy: true, heartStarted: true, heartCode: 0,
    heartOutput: '{"recorded":true,"plugin":{"hearts":2}}', heartedIds: [],
    flashed: [], flashStatus(text, err) { state.flashed.push([text, err]) },
    saveHeartedId(id) { saved.push(id); return true },
    bumpCatalogCount() {}, loadCatalog() {},
  }
  callStore("finishHeart", state)
  assert.deepEqual(state.heartedIds, [entry.id])
  assert.deepEqual(saved, [entry.id])
  assert.deepEqual(state.flashed, [['"Ente Auth" was liked.', false]])
})

test("hearted ids persist in a file both surfaces watch", () => {
  assert.match(source, /readonly property string heartsPath: Model\.heartsCachePath\(Quickshell\.env\("HOME"\)\)/)
  assert.match(source, /id: heartsFile[\s\S]*?onLoaded: root\.unionHearts\(text\(\)\)/)
  assert.match(source, /onFileChanged: if \(root\.unionHearts\(text\(\)\)\) root\.loadCatalog\(true\)/)
  assert.match(source, /watchChanges: root\.heartsPath !== ""/)
  assert.match(source, /id: heartSaveProc/)
  assert.match(source, /function unionHearts\(text\)/)
  assert.match(source, /function saveHeartedId\(id\)/)
  assert.match(source, /return missing\.length > 0/)
  // Star and like notices clear themselves; install and update traffic keeps
  // the persistent path.
  assert.match(source, /function flashStatus\(text, isError\)/)
  assert.match(source, /id: flashTimer[\s\S]*?interval: 4000/)
  assert.match(source, /if \(root\.status !== "" && root\.status === root\.flashedText\) root\.setStatus\("", false\)/)
  for (const message of ["Checking the star for ", "Starred ", "Removed the star from ",
    "Could not change the star for ", "was liked.", "was already liked.", "Could not like ", "Liking "]) {
    assert.ok(source.includes(message), message)
  }
  assert.ok(!source.includes("Heart sent to ") && !source.includes("Heart already sent to ")
    && !source.includes("Heart already counted") && !source.includes("Heart could not be sent")
    && !source.includes("Sending a heart"), "no heart-worded notice remains")
})
