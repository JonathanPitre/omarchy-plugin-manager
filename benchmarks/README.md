# GitHub star performance

The star helper checks GitHub on every click and sends the matching PUT or
DELETE on the same HTTPS connection. It reads the current credential through
`gh auth token`. No star state or credential is retained between clicks.
Configured proxies use the existing two-request `gh api` path.

## Controlled add and remove benchmark

The benchmark loads the shipped QML store and Model in offscreen Quickshell.
It uses the real GitHub CLI, an isolated fake credential, and a loopback API
that verifies each state change. The catalog has 548 entries. Every measured
click includes a fresh GET, a mutation, and the store's successful status.

Each workload has five alternating baseline/candidate runs of ten actions.
The repeated workload alternates add and remove on one repository. The first
toggle workload uses different repositories, half initially starred.
No first clicks are discarded. Throughput divides the completed actions by
their total click-to-success time. Fixture startup and validation between
clicks are excluded. Rendered cards and pointer dispatch are not measured.

With 100 ms per request and a **modeled 50 ms cost per new connection**, the
[connection-cost results](results/star-toggle-connection50.json) show:

| Workload | Before, actions/s | After, actions/s | Improvement | Median click latency |
| --- | --- | --- | --- | --- |
| Repeated toggles | 2.552, range 2.516–2.567 | 2.958, range 2.921–3.005 | 15.9% | 393.5 → 338 ms |
| First toggles | 2.572, range 2.534–2.575 | 2.957, range 2.910–3.014 | 15.0% | 388.5 → 340.5 ms |

The 200 actions produced 200 GETs and 200 writes with zero errors.
The baseline opened two API sockets per action. The helper opened one.
Both sides still wait for two API responses. The residual cost stays near
90 ms, so eliminating one 50 ms setup cost explains the gain.

The [zero-setup control](results/star-toggle-comparison.json) keeps the same
100 ms request delay and removes the connection cost. Repeated throughput
changes from 3.423 to 3.501 actions/s. First-toggle throughput changes from
3.439 to 3.490 actions/s, with overlapping ranges. That small gain is not
evidence of a large speedup when connection setup is free.

The setup delay is added to the first response on each TCP socket. It models
connection cost; it does not perform a real TLS handshake. The real TLS path
is checked separately below. A shared desktop remained active during the
alternating trials. Every output records versions, source hashes, timings,
request counts, connection counts, and final state.

Reproduce with fresh output paths. To match this run, select the installed
GitHub CLI 2.102.0 binary with `--gh-path`.

```bash
node benchmarks/star-toggle.mjs --baseline-ref 157c715b6000d56c664452d8f7908339c6d928e1 --runs 5 --connection-delay-ms 50 --output /tmp/star-connection-results.json
node benchmarks/star-toggle.mjs --baseline-ref 157c715b6000d56c664452d8f7908339c6d928e1 --runs 5 --connection-delay-ms 0 --output /tmp/star-control-results.json
```

The default binary is `/usr/bin/gh`. Use `--diagnostic --output /tmp/star-cpu.json`
for a separate CPU accounting run. Diagnostic runs are excluded from reported
performance. The comparison files' verdict labels were corrected after capture.
Their timed samples and original measured-script hashes were preserved.

## Live read-only check

[Seven initial pairs](results/star-readonly-initial.json) were inconclusive.
Only four favored the helper, and the ranges were wide. The
[ten-pair follow-up](results/star-readonly-followup.json) favored the helper
in every pair. Median time for two authenticated GETs changed from 1.130 s
to 0.973 s. The ranges were 1.045–1.496 s and 0.868–1.071 s respectively.
Both batches are retained. These are read timings, not live write throughput.

An excluded follow-up trace measured 45.8 ms for local authentication,
118.7 ms for connection and TLS setup, and 406.9 ms plus 379.0 ms waiting for
responses. The second send took 0.164 ms on the same socket. This supports
testing a 50 ms connection model while keeping response waiting as the limiter.

The probe converts every attempted mutation to GET and asserts socket reuse.
It expects `cli/cli` to be unstarred and both responses to be 404. It refuses
other outcomes without changing any star.

```bash
python3 benchmarks/star-readonly.py /tmp/star-readonly-results.json
```
