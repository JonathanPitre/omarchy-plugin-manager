import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
const modelSource = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(modelSource + "\nreturn { engagementPluginId, parseHeartResult, heartPostCommand }")()

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
    setStatus() {},
    bumpCatalogCount() { assert.fail("a repeat must not invent a count increment") },
    loadCatalog(force) { assert.equal(force, true); entry.marketplaceHearts = 1 },
  }
  callStore("finishHeart", state)
  assert.equal(entry.marketplaceHearts, 1)
  assert.deepEqual(state.heartedIds, [entry.id])
})

test("a locally remembered heart still refreshes the count after catalog reload", () => {
  const entry = { id: "lcd1232.ente-auth", name: "Ente Auth", marketplaceHearts: 0 }
  const state = {
    Model, heartBusy: false, isHearted: () => true, setStatus() {},
    loadCatalog(force) { assert.equal(force, true); entry.marketplaceHearts = 1 },
  }
  assert.equal(callStore("sendHeart", state, entry), true)
  assert.equal(entry.marketplaceHearts, 1)
})
