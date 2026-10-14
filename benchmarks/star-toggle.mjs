#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { availableParallelism, cpus, release, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const options = { runs: 5, operations: 10, latencyMs: 100, baselineRef: "", baselineOnly: false, diagnostic: false,
  output: "", connectionDelayMs: 0, ghPath: "/usr/bin/gh" }
const flags = { "--runs": "runs", "--operations": "operations", "--baseline-ref": "baselineRef",
  "--output": "output",
  "--connection-delay-ms": "connectionDelayMs", "--gh-path": "ghPath" }
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === "--help") {
    console.log(`Usage: node benchmarks/star-toggle.mjs [--baseline-ref HEAD] [--baseline-only]
  [--runs 5] [--operations 10] [--output benchmarks/results/star-toggle-baseline.json]
  [--diagnostic]
  [--gh-path /absolute/path/to/gh] [--connection-delay-ms 0]

With --baseline-ref, alternate baseline/current runs for each scenario. Without it,
measure current source only. --baseline-only measures just the Git snapshot.
Each scenario starts a fresh offscreen store. Operations must be even (2..548).
Every click requires one fresh GET and one mutation. Helper snapshots substitute
only api.github.com and HTTPSConnection in the isolated fixture. Local gh auth
uses the selected real gh binary with a fake token and isolated configuration.
--connection-delay-ms adds that fixed cost to the first response per TCP socket.
Use 0 ms as the connection-delay control. Existing output files are never replaced.
--diagnostic runs one round by default with separate wait4 CPU accounting.
Diagnostic output must be outside benchmarks/results and is never a baseline.`)
    process.exit(0)
  }
  if (arg === "--baseline-only") options.baselineOnly = true
  else if (arg === "--diagnostic") options.diagnostic = true
  else {
    assert.ok(flags[arg] && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"), `Unknown or incomplete option ${arg}`)
    options[flags[arg]] = process.argv[++i]
  }
}
if (options.diagnostic && !process.argv.includes("--runs")) options.runs = 1
for (const key of ["runs", "operations", "connectionDelayMs"]) {
  if (options[key] !== null) options[key] = Number(options[key])
}
assert.ok(Number.isInteger(options.runs) && options.runs >= 1, "runs must be positive")
assert.ok(Number.isInteger(options.operations) && options.operations >= 2 && options.operations <= 548 && options.operations % 2 === 0,
  "operations must be even and between 2 and 548")
assert.ok(!options.baselineOnly || options.baselineRef, "--baseline-only requires --baseline-ref")
assert.ok(Number.isFinite(options.connectionDelayMs) && options.connectionDelayMs >= 0, "connection delay must be nonnegative")
options.ghPath = resolve(options.ghPath)
options.output = resolve(root, options.output || (options.diagnostic
  ? join(tmpdir(), "star-toggle-diagnostic.json") : "benchmarks/results/star-toggle-baseline.json"))
assert.ok(!options.diagnostic || !options.output.startsWith(join(root, "benchmarks/results") + "/"),
  "Keep diagnostic output outside benchmarks/results")
assert.ok(!existsSync(options.output), `Output already exists: ${options.output}`)

const command = (file, args = []) => execFileSync(file, args, { cwd: root, encoding: "utf8", timeout: 15000 }).trim()
const hash = value => createHash("sha256").update(value).digest("hex")
const sha = command("git", ["rev-parse", "HEAD"])
const sourceFiles = ["PluginStore.qml", "Model.js", "helpers/github_star.py"]
const helperConnection = /http\.client\.HTTPSConnection\(\s*(["'])api\.github\.com\1\s*,/
function snapshot(label, ref) {
  const commit = ref ? command("git", ["rev-parse", "--verify", `${ref}^{commit}`]) : sha
  const included = ref ? command("git", ["ls-tree", "-r", "--name-only", commit, "--", ...sourceFiles]).split("\n")
    : sourceFiles.filter(file => existsSync(join(root, file)))
  assert.ok(included.includes("PluginStore.qml") && included.includes("Model.js"), "Incomplete source snapshot")
  const files = Object.fromEntries(included.sort().map(file => [file, ref
    ? execFileSync("git", ["show", `${commit}:${file}`], { cwd: root }) : readFileSync(join(root, file))]))
  const hashes = Object.fromEntries(included.map(file => [file, hash(files[file])]))
  return { label, commit, ref: ref || "working tree", files, hashes, sourceHash: hash(JSON.stringify(hashes)) }
}
const sources = options.baselineRef ? [snapshot("baseline", options.baselineRef)] : []
if (!options.baselineOnly) sources.push(snapshot("current", null))
const machine = {
  uptimeBefore: command("uptime"), nproc: Number(command("nproc")), availableParallelism: availableParallelism(),
  cpu: cpus()[0].model, kernel: release(),
  busyProcessesBefore: command("ps", ["-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu"]).split("\n").slice(0, 13),
  versions: { node: process.version, gh: command(options.ghPath, ["--version"]),
    quickshell: command("/usr/bin/quickshell", ["--version"]), qt: command("/usr/bin/qmake6", ["-query", "QT_VERSION"]) }
}

const catalog = Array.from({ length: 548 }, (_, i) => ({
  id: `bench.plugin-${i}`, name: `Desktop ${["Weather", "Music", "Calendar", "Network", "Tasks", "Notes"][i % 6]} ${i}`,
  repo: `https://github.com/bench-owner/plugin-${i}`, author: `Maintainer ${i % 37}`, version: `1.${i % 12}.${i % 9}`,
  description: "A desktop plugin with a configurable panel, keyboard shortcuts, and compact status information. ".repeat(3),
  category: ["Productivity", "System", "Media", "Utilities"][i % 4], kind: i % 3 ? "widget" : "application",
  stars: 30 + i % 240, marketplaceHearts: i % 23, listedAt: "2026-09-01T12:00:00Z", addedAt: "2026-08-01T12:00:00Z",
  accent: "#83a598", initials: "DP", license: "MIT", previewThumbnail: `https://omarchyplugins.com/previews/plugin-${i}.webp`,
  installCommand: `omarchy-plugin-install https://github.com/bench-owner/plugin-${i}`, installAvailable: true,
  verificationStatus: i % 4 ? "verified" : "unverified", verificationCommit: "a".repeat(40), listingValidatedBranch: "main"
}))
function planFor(scenario) {
  return Array.from({ length: options.operations }, (_, i) => {
    const index = scenario === "warm" ? 0 : i
    const initial = scenario === "cold" && i % 2 === 1
    const before = scenario === "warm" ? i % 2 === 1 : initial
    return { index, slug: `bench-owner/plugin-${index}`, before, after: !before,
      method: before ? "DELETE" : "PUT", count: catalog[index].stars + (scenario === "warm" ? (before ? 0 : 1) : (before ? -1 : 1)) }
  })
}

const wrapper = `#!/bin/bash
set -euo pipefail
if [[ $# == 4 && "$1" == auth && "$2" == token && "$3" == --hostname && "$4" == github.com ]]; then
  printf '{"kind":"auth","startedSeconds":%s}\\n' "$EPOCHREALTIME" >> "$STAR_BENCH_GH_LOG"
  if [[ -n "\${STAR_BENCH_PROFILE_DIR:-}" ]]; then
    exec /usr/bin/python3 -I -S "$STAR_BENCH_PROFILE_RUNNER" "$STAR_BENCH_PROFILE_DIR" "$STAR_BENCH_GH" "$@"
  fi
  exec "$STAR_BENCH_GH" "$@"
fi
[[ "$1" == api && "$2" == --silent ]] || exit 90
method=GET
if [[ $# == 3 ]]; then endpoint=$3
elif [[ $# == 5 && ( "$3" == -X || "$3" == --method ) && ( "$4" == PUT || "$4" == DELETE ) ]]; then
  method=$4; endpoint=$5
else exit 91; fi
[[ "$endpoint" =~ ^user/starred/bench-owner/plugin-[0-9]+$ ]] || exit 92
args=(api --silent -X "$method" "$STAR_BENCH_ORIGIN/$endpoint")
printf '{"kind":"api","startedSeconds":%s}\\n' "$EPOCHREALTIME" >> "$STAR_BENCH_GH_LOG"
if [[ -n "\${STAR_BENCH_PROFILE_DIR:-}" ]]; then
  exec /usr/bin/python3 -I -S "$STAR_BENCH_PROFILE_RUNNER" "$STAR_BENCH_PROFILE_DIR" "$STAR_BENCH_GH" "\${args[@]}"
fi
exec "$STAR_BENCH_GH" "\${args[@]}"
`
const profiler = `import json, os, sys, time
started = time.monotonic()
pid = os.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
_, status, usage = os.wait4(pid, 0)
with open(os.path.join(sys.argv[1], str(os.getpid()) + '.json'), 'w') as output:
    json.dump(dict(command=sys.argv[2:], userMs=usage.ru_utime*1000, systemMs=usage.ru_stime*1000,
                   wallMs=(time.monotonic()-started)*1000, exitCode=os.waitstatus_to_exitcode(status)), output)
sys.exit(os.waitstatus_to_exitcode(status))
`

function fixture(plan) {
  return `import QtQuick
import Quickshell
import "." as Plugin
import "Model.js" as Model
ShellRoot {
  Plugin.PluginStore { id: store; watchConfig: false }
  property var plan: ${JSON.stringify(plan)}
  property var samples: []
  property int cursor: 0
  property double started: 0
  property double finished: 0
  property bool awaiting: false
  property bool failed: false
  function check(ok, message) {
    if (ok) return true
    failed = true
    console.log("STAR_BENCH_FAILURE:" + message)
    Qt.callLater(Qt.quit)
    return false
  }
  function next() {
    if (failed) return
    if (cursor === plan.length) {
      console.log("STAR_BENCH_RESULT:" + JSON.stringify(samples))
      Qt.callLater(Qt.quit)
      return
    }
    var action = plan[cursor]
    if (!check(store.catalog[action.index].repo === "https://github.com/" + action.slug, "Fixture repository mismatch")) return
    awaiting = true
    started = Date.now()
    check(store.toggleStar(store.catalog[action.index]) === true, "Click was skipped at " + cursor)
  }
  function complete() {
    if (failed) return
    var action = plan[cursor]
    if (!check(!store.starBusy && !store.statusIsError, "Store error or busy at " + cursor)) return
    if (!check(store.catalog.length === 548, "Catalog size changed")) return
    for (var i = 0; i < store.catalog.length; i++) {
      var expected = 30 + i % 240
      if (i === action.index) expected = action.count
      else if (${JSON.stringify(plan[0].index !== plan[1].index)} && i < cursor) expected += i % 2 ? -1 : 1
      if (!check(store.catalog[i].stars === expected && store.starsById[store.catalog[i].id] === expected,
                 "Wrong catalog or derived count at " + cursor + "/" + i)) return
    }
    samples.push({ index: cursor, startedMs: started, finishedMs: finished, latencyMs: finished - started,
                   status: store.status, count: store.catalog[action.index].stars })
    cursor++
    Qt.callLater(next)
  }
  Connections {
    target: store
    function onStatusChanged() {
      if (!awaiting || failed) return
      var action = plan[cursor]
      var expected = (action.after ? "Starred " : "Removed the star from ") + store.catalog[action.index].name
      if (store.status !== expected) return
      finished = Date.now()
      awaiting = false
      Qt.callLater(complete)
    }
    function onBrowseUrlRequested(url) { check(false, "Unexpected browser fallback " + url) }
  }
  Component.onCompleted: {
    var built = Model.buildCatalog(${JSON.stringify(JSON.stringify({ plugins: catalog }))}, [])
    if (!check(built.error === "" && built.entries.length === 548, "Catalog preparation failed")) return
    built.entries.sort(function(a, b) { return Number(a.id.split("-").pop()) - Number(b.id.split("-").pop()) })
    store.catalog = built.entries
    store.catalogLoaded = true
    if (!check(Object.keys(store.starsById).length === 548 && Object.keys(store.verifiedIds).length > 0,
               "Catalog bindings failed")) return
    Qt.callLater(next)
  }
  Timer { interval: ${30000 + options.operations * 1000}; running: true
    onTriggered: check(false, "QML watchdog expired") }
}`
}

const workspace = mkdtempSync(join(tmpdir(), "star-toggle-bench-"))
let activeChild
function killGroup() {
  if (activeChild) {
    try { process.kill(-activeChild.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
    activeChild = null
  }
}
function interrupted() { killGroup(); process.exitCode = 130 }
process.once("SIGINT", interrupted)
process.once("SIGTERM", interrupted)
const runs = []
try {
  mkdirSync(join(workspace, "bin"))
  writeFileSync(join(workspace, "bin/gh"), wrapper, { mode: 0o700 })
  writeFileSync(join(workspace, "profile.py"), profiler)
  for (let round = 0; round < options.runs; round++) {
    for (const scenario of ["warm", "cold"]) {
      for (const source of sources) {
        assert.notEqual(process.exitCode, 130, "Interrupted")
        const result = await run(source, scenario, round + 1)
        runs.push(result)
        console.error(`${source.label} ${scenario} ${round + 1}/${options.runs}: median ${stats(result.samples.map(s => s.latencyMs)).median.toFixed(1)} ms; GET ${result.counts.GET}, PUT ${result.counts.PUT}, DELETE ${result.counts.DELETE}; errors 0`)
      }
    }
  }
  machine.uptimeAfter = command("uptime")
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), diagnostic: options.diagnostic,
    verdict: options.diagnostic ? "Separate diagnostic, excluded from benchmark statistics"
      : sources.length === 2 ? "Comparison captured; assess the medians, ranges, and transport model"
      : "Baseline captured; no optimization or speedup claim",
    reproduction: [process.execPath, "benchmarks/star-toggle.mjs", ...process.argv.slice(2)],
    scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    sources: sources.map(({ label, commit, ref, hashes, sourceHash }) => ({ label, commit, ref, hashes, sourceHash })),
    settings: { ...options, catalogEntries: catalog.length, rawCatalogBytes: Buffer.byteLength(JSON.stringify({ plugins: catalog })),
      catalogSha256: hash(JSON.stringify(catalog)), concurrency: 1, expectedMutationsPerRun: options.operations,
      timing: "Date.now immediately before toggleStar to its successful statusChanged signal; 1 ms resolution",
      warm: "Fresh engine, same repository, sequential alternating add/remove including its first lookup",
      cold: "Fresh engine, distinct repositories, first lookup each; alternate initially unstarred/starred",
      isolation: "Fresh HOME, XDG and gh config per run, fake token, allowlisted gh wrapper, loopback HTTP only" },
    transportModel: "100 ms per request plus connectionDelayMs added to the first response on each accepted TCP connection. This models connection setup cost, not an actual TLS handshake. Run with 0 ms as the control.",
    machine, runOrder: runs.map(({ label, scenario, round }) => ({ label, scenario, round })),
    summaries: sources.flatMap(source => ["warm", "cold"].map(scenario => summarize(runs.filter(r => r.label === source.label && r.scenario === scenario)))),
    limitations: ["No rendered cards, pointer dispatch, frame presentation, sorting or grid rebuild cost; measures the store action used by the click handler.",
      "Deterministic synthetic catalog normalized by the real Model.buildCatalog, not a downloaded marketplace snapshot.",
      "Fixed 100 ms per HTTP request includes no WAN, TLS, GitHub rate limits, auth refresh or failures; expected 404 GET responses are not errors.",
      "Cold means an unseen repository in a fresh store, not a flushed OS page cache; QML loading and catalog preparation are outside click latency.",
      "No warmup clicks are discarded. First-click latency and all distinct-repository latencies are included.",
      "Residual time includes gh and wrapper startup, loopback transport, QML updates and scheduling; it is not pure QML CPU time.",
      "The shared desktop remains active. A/B runs alternate per scenario, but are not CPU pinned or randomized.",
      "Desktop moshi-hook service-discovery GET / probes are recorded separately as auxiliaryProbes, outside star API request counts and delay accounting.",
      "A helper fixture uses HTTPConnection and a loopback host in place of the production HTTPSConnection and fixed GitHub host; source and adapted hashes are recorded. The fixture adapter still evaluates the original SSL context argument."],
    runs
  }
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ artifact: options.output, summaries: report.summaries }, null, 2))
} finally {
  killGroup()
  process.removeListener("SIGINT", interrupted)
  process.removeListener("SIGTERM", interrupted)
  rmSync(workspace, { recursive: true, force: true })
}

async function run(source, scenario, round) {
  const plan = planFor(scenario)
  const dir = join(workspace, `${source.label}-${scenario}-${round}`)
  mkdirSync(dir)
  const helper = source.files["helpers/github_star.py"]?.toString("utf8")
  if (helper) {
    assert.match(helper, helperConnection, "Helper must have the expected fixed HTTPSConnection to substitute")
    assert.match(helper, /^def /m, "Helper must have a place for the fixture connection adapter")
  }
  const env = { PATH: join(workspace, "bin") + ":/usr/bin:/bin", HOME: dir, QT_QPA_PLATFORM: "offscreen",
    QML_DISABLE_DISK_CACHE: "1", GH_TOKEN: "fake-star-toggle-benchmark-token", GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1", GH_CONFIG_DIR: join(dir, "gh-config"), STAR_BENCH_GH: options.ghPath,
    STAR_BENCH_GH_LOG: join(dir, "gh-calls.jsonl") }
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "GH_CONFIG_DIR"]) {
    env[key] ||= join(dir, key)
    mkdirSync(env[key], { mode: 0o700 })
  }
  const state = new Map(plan.map(action => [action.slug, scenario === "cold" ? action.before : false]))
  const requests = [], errors = [], auxiliaryProbes = []
  const connections = new WeakMap()
  let nextConnection = 0
  let inFlight = 0
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/" && req.headers["user-agent"] === "Go-http-client/1.1") {
      auxiliaryProbes.push({ method: req.method, path: req.url, agent: req.headers["user-agent"], receivedMs: Date.now() })
      res.writeHead(204).end()
      return
    }
    const slug = req.url?.match(/^\/user\/starred\/(bench-owner\/plugin-\d+)$/)?.[1]
    if (!state.has(slug) || !["GET", "PUT", "DELETE"].includes(req.method) || inFlight) {
      errors.push(`Unexpected/concurrent request ${req.method} ${req.url}; agent=${req.headers["user-agent"] || "none"}`)
      res.writeHead(400).end()
      return
    }
    if (helper && req.headers.authorization?.split(" ").pop() !== env.GH_TOKEN) {
      errors.push("Helper did not send the isolated fake token")
      res.writeHead(401).end()
      return
    }
    inFlight++
    const connection = connections.get(req.socket)
    const connectionDelayMs = connection.used ? 0 : options.connectionDelayMs
    const newConnection = !connection.used
    connection.used = true
    const before = state.get(slug)
    const item = { method: req.method, slug, before, connectionId: connection.id, newConnection, connectionDelayMs,
      receivedMs: Date.now(), status: req.method === "GET" && !before ? 404 : 204 }
    const started = performance.now()
    requests.push(item)
    setTimeout(() => {
      if (req.method !== "GET") state.set(slug, req.method === "PUT")
      item.after = state.get(slug)
      item.delayMs = performance.now() - started
      item.respondedMs = Date.now()
      inFlight--
      res.writeHead(item.status).end()
    }, options.latencyMs + connectionDelayMs)
  })
  server.on("connection", socket => connections.set(socket, { id: ++nextConnection, used: false }))
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen) })
  env.STAR_BENCH_ORIGIN = `http://127.0.0.1:${server.address().port}`
  let helperFixture = null
  for (const [file, contents] of Object.entries(source.files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    const adapted = file === "helpers/github_star.py" ? helper
      .replace(helperConnection, `_benchmark_connection(${JSON.stringify(`127.0.0.1:${server.address().port}`)},`)
      .replace(/^def /m, "def _benchmark_connection(host, *, timeout, context):\n    return http.client.HTTPConnection(host, timeout=timeout)\n\n\ndef ") : contents
    writeFileSync(join(dir, file), adapted)
    if (file === "helpers/github_star.py") helperFixture = { sourceSha256: hash(contents), fixtureSha256: hash(adapted),
      substitutions: "HTTPSConnection with its fixed API host to an HTTPConnection adapter at loopback host:port. Original timeout and SSL context construction remain evaluated. No business logic changes." }
  }
  const shell = join(dir, "shell.qml")
  writeFileSync(shell, fixture(plan))
  let executable = "/usr/bin/quickshell", args = ["--no-color", "--path", shell]
  if (options.diagnostic) {
    env.STAR_BENCH_PROFILE_DIR = join(dir, "cpu")
    env.STAR_BENCH_PROFILE_RUNNER = join(workspace, "profile.py")
    mkdirSync(env.STAR_BENCH_PROFILE_DIR)
    args = ["-I", "-S", env.STAR_BENCH_PROFILE_RUNNER, env.STAR_BENCH_PROFILE_DIR, executable, ...args]
    executable = "/usr/bin/python3"
  }
  const cpuStart = process.cpuUsage(), wallStart = performance.now()
  let logs = "", watchdog
  try {
    const exitCode = await new Promise((resolveExit, reject) => {
      activeChild = spawn(executable, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      watchdog = setTimeout(() => { killGroup(); reject(new Error("Node watchdog expired")) }, 35000 + options.operations * 1000)
      activeChild.on("error", reject)
      activeChild.on("close", (code, signal) => signal ? reject(new Error(`Quickshell signal ${signal}`)) : resolveExit(code))
      for (const stream of [activeChild.stdout, activeChild.stderr]) stream.on("data", chunk => { logs += chunk.toString() })
    })
    assert.equal(exitCode, 0, logs)
    assert.doesNotMatch(logs, /STAR_BENCH_FAILURE|ReferenceError|TypeError|Error loading configuration|Failed to load/i, logs)
    const matches = [...logs.matchAll(/STAR_BENCH_RESULT:(\[[^\n]*\])/g)]
    assert.equal(matches.length, 1, logs)
    const samples = JSON.parse(matches[0][1])
    assert.equal(samples.length, plan.length)
    assert.deepEqual(errors, [])
    const ghCalls = readFileSync(env.STAR_BENCH_GH_LOG, "utf8").trim().split("\n").map(line => JSON.parse(line))
    const localGhCounts = Object.fromEntries(["api", "auth"].map(kind => [kind, ghCalls.filter(call => call.kind === kind).length]))
    assert.deepEqual(localGhCounts, { api: helper ? 0 : options.operations * 2, auth: helper ? options.operations : 0 })
    const counts = Object.fromEntries(["GET", "PUT", "DELETE"].map(method => [method, requests.filter(r => r.method === method).length]))
    assert.deepEqual(counts, { GET: options.operations, PUT: options.operations / 2, DELETE: options.operations / 2 })
    for (let i = 0; i < plan.length; i++) {
      const action = plan[i], sample = samples[i]
      assert.equal(sample.index, i)
      assert.equal(sample.count, action.count)
      assert.ok(sample.latencyMs > 0)
      if (i) assert.ok(sample.startedMs >= samples[i - 1].finishedMs, "Clicks overlapped")
      const work = requests.filter(r => r.receivedMs >= sample.startedMs && r.respondedMs <= sample.finishedMs && r.slug === action.slug)
      const mutations = work.filter(r => r.method !== "GET")
      assert.equal(mutations.length, 1, `Skipped or duplicated mutation at ${i}`)
      assert.deepEqual([mutations[0].method, mutations[0].before, mutations[0].after, mutations[0].status],
        [action.method, action.before, action.after, 204])
      const gets = work.filter(r => r.method === "GET")
      assert.equal(gets.length, 1)
      for (const get of gets) {
        assert.equal(get.status, action.before ? 204 : 404)
        assert.equal(get.before, action.before)
        assert.ok(get.respondedMs <= mutations[0].receivedMs)
      }
      sample.requests = work
      sample.ghCalls = ghCalls.filter(call => call.startedSeconds * 1000 >= sample.startedMs && call.startedSeconds * 1000 <= sample.finishedMs)
      assert.deepEqual(sample.ghCalls.map(call => call.kind), helper ? ["auth"] : ["api", "api"])
      sample.newConnections = work.filter(r => r.newConnection).length
      sample.fixedRequestDelayMs = work.length * options.latencyMs
      sample.fixedConnectionDelayMs = work.reduce((sum, r) => sum + r.connectionDelayMs, 0)
      sample.fixedDelayMs = sample.fixedRequestDelayMs + sample.fixedConnectionDelayMs
      sample.observedServerDelayMs = work.reduce((sum, request) => sum + request.delayMs, 0)
      sample.residualMs = sample.latencyMs - sample.observedServerDelayMs
      assert.ok(sample.residualMs >= -2, "Request delay exceeds click latency")
    }
    assert.equal(samples.flatMap(s => s.requests).length, requests.length, "Requests outside measured clicks")
    assert.equal(samples.flatMap(s => s.ghCalls).length, ghCalls.length, "gh invocations outside measured clicks")
    assert.equal(new Set(requests.map(r => r.connectionId)).size, options.operations * (helper ? 1 : 2), "Wrong connection reuse count")
    for (const sample of samples) assert.equal(new Set(sample.requests.map(r => r.connectionId)).size, helper ? 1 : 2)
    for (const [slug, starred] of state) assert.equal(starred, [...plan].reverse().find(action => action.slug === slug).after)
    const result = { label: source.label, scenario, round, counts, localGhCounts, helperFixture, errors: 0,
      expected404s: requests.filter(r => r.status === 404).length, acceptedTCPConnections: nextConnection,
      apiConnections: new Set(requests.map(r => r.connectionId)).size, auxiliaryProbes,
      finalState: Object.fromEntries(state), samples }
    if (options.diagnostic) result.profile = { excludedFromBenchmark: true,
      nodeCpuMs: Object.fromEntries(Object.entries(process.cpuUsage(cpuStart)).map(([key, value]) => [key, value / 1000])),
      wallIncludingStartupMs: performance.now() - wallStart,
      childCpu: readdirSync(env.STAR_BENCH_PROFILE_DIR).map(file => JSON.parse(readFileSync(join(env.STAR_BENCH_PROFILE_DIR, file), "utf8"))) }
    return result
  } catch (error) {
    throw new Error(`${source.label}/${scenario}/${round}: ${error.message}\nServer errors: ${JSON.stringify(errors)}\n${logs.slice(-5000)}`, { cause: error })
  } finally {
    clearTimeout(watchdog)
    killGroup()
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length
  return { median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2, min: sorted[0], max: sorted[n - 1] }
}
function summarize(selected) {
  const samples = selected.flatMap(run => run.samples)
  const latencies = samples.map(s => s.latencyMs)
  const elapsed = latencies.reduce((a, b) => a + b, 0)
  const delay = samples.reduce((sum, s) => sum + s.observedServerDelayMs, 0)
  const runMedian = run => stats(run.samples.map(s => s.latencyMs)).median
  return { label: selected[0].label, scenario: selected[0].scenario, runs: selected.length,
    operations: samples.length, errors: 0, requests: selected.reduce((sum, r) => sum + r.counts.GET + r.counts.PUT + r.counts.DELETE, 0),
    localGhCounts: { api: selected.reduce((sum, r) => sum + r.localGhCounts.api, 0), auth: selected.reduce((sum, r) => sum + r.localGhCounts.auth, 0) },
    newConnections: samples.reduce((sum, s) => sum + s.newConnections, 0),
    runMedianLatencyMs: stats(selected.map(runMedian)), allClickLatencyMs: stats(latencies),
    firstClickLatencyMs: stats(selected.map(run => run.samples[0].latencyMs)),
    addLatencyMs: stats(samples.filter(s => s.requests.some(r => r.method === "PUT")).map(s => s.latencyMs)),
    removeLatencyMs: stats(samples.filter(s => s.requests.some(r => r.method === "DELETE")).map(s => s.latencyMs)),
    throughputActionsPerSecond: stats(selected.map(run => run.samples.length * 1000 / run.samples.reduce((sum, s) => sum + s.latencyMs, 0))),
    throughputBasis: "Sum of click-to-success latency; validation between clicks and fixture startup excluded",
    serverDelayShare: delay / elapsed,
    totalClickLatencyMs: elapsed,
    fixedDelayThroughputCeilingActionsPerSecond: samples.length * 1000 / samples.reduce((sum, s) => sum + s.fixedDelayMs, 0),
    fixedDelayMs: samples.reduce((sum, s) => sum + s.fixedDelayMs, 0), observedServerDelayMs: delay,
    fixedRequestDelayMs: samples.reduce((sum, s) => sum + s.fixedRequestDelayMs, 0),
    fixedConnectionDelayMs: samples.reduce((sum, s) => sum + s.fixedConnectionDelayMs, 0),
    residualLatencyMs: stats(samples.map(s => s.residualMs)),
    limiter: "Sequential HTTP delay; compare serverDelayShare with residualLatencyMs. CPU evidence is a separate --diagnostic run." }
}
