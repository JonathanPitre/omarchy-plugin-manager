# Search field clipboard exposure: marketplace finding on #11673

## Objective
Close the HANCORE-linux security finding on omacom/omarchy-plugin-marketplace#11673 (2026-10-15): the popup's search field stays editable while the panel is hidden, so on the Qt 6.12 Wayland path every clipboard change makes the shell read foreign text without a byte cap or deadline.

## Problem
- `BarWidget.qml` keeps `Panel.qml` permanently loaded (`panelLoader.active: true`).
- `Panel.qml` search `TextField` (qs.Ui TextField = QtQuick.Controls TextField over QQuickTextInput) exists for the shell's lifetime; `Expanded.qml` has the same field.
- QQuickTextInput connects to `QClipboard::dataChanged` at construction, so `readOnly`/`enabled: false` is not a sufficient fix: the field must not exist while its surface is closed.

## Why
The marketplace Verify request cannot pass while the finding is open. The shell is shared by every widget, so an unbounded clipboard read can stall or exhaust the whole desktop.

## Scope (authorized)
- Instantiate each search field only while its surface is open (a `Loader` active on the surface's `opened` state), with the query held in a root property so search behaviour survives close/open exactly as today.
- Tests that pin the new structure and the unchanged search behaviour.
- No change to BarWidget's permanent panel loading, store, helpers or other UI.

## Constraints
- Strict TDD: observe RED before implementation.
- Behaviour preserved: typing, debounce, Enter/Escape, `/` focus, clear button, restoring a query, clear-filters.
- Every QML Text stays `textFormat: Text.PlainText`.

## Tasks
- [x] T1: Panel.qml search field only exists while the popup is open; query in a root property; all `searchField` references go through it. Tests first.
- [x] T2: Expanded.qml, same treatment. Tests first.
- [x] T3: Full suites green; local deploy and shell restart; user checks search in popup and window.
- [ ] T4: Native review; commit; release v1.10.14; retarget #11673 body and title to the release commit; reply to HANCORE-linux with the fix commit and file:line.

## Acceptance criteria
- With the popup and the expanded window closed, no TextField/TextInput from this plugin exists in the shell.
- Search works as before in both surfaces.
- Node and Python suites green apart from the known flaky `test_timer_edge_scroll_and_drop_gap`.

## Checks
- TDD mode: on (source: user global instructions, "Strict TDD Mode: enabled").
- Runners: `node --test test/*.test.mjs`; `python3 -m unittest discover -s test -p 'test_*.py'`.

## Progress
- 2026-10-17: document created on branch `fix/search-field-clipboard` off master bd3e107 (v1.10.13).
- 2026-10-17 T1+T2 RED: new `test/search-field.test.mjs` 8/8 failing (no `searchFieldLoader`, no `searchText`, bare `searchField` reads outside the field); new `test/test_search_field_ui.py` failing for both surfaces (`property string searchText: "" not found`).
- 2026-10-17 T1+T2 GREEN: both surfaces wrap the TextField in `Loader { id: searchFieldLoader; active: root.opened }` carrying the old geometry; the term lives in `root.searchText` (debounce, flush and clear driven from `onSearchTextChanged`); outside reads go through `searchFieldFocused` / `focusSearchField()`. Closing never cleared the search before and still does not: the term survives close/reopen. Existing pins updated in `test/model.test.mjs` and `test/popup-arrange.test.mjs`. `node --test test/*.test.mjs`: 445/445 pass. `python3 -m unittest discover -s test -p 'test_*.py'`: 208 run, only the known `test_timer_edge_scroll_and_drop_gap` fails. textFormat audit: no output. No other TextField/TextInput/TextEdit/TextArea or clipboard use in plugin QML.
- 2026-10-17 follow-up: both fields gained `maximumLength: 256` (security skill ingress rule). RED: two new cap tests failed; GREEN: Node 447/447, Python 208 with only the known flaky failure.
- 2026-10-17 T3 in progress: Panel.qml and Expanded.qml copied into the local install, qmlcache cleared, shell restarted, no plugin-manager warnings. Waiting for the user to check search in the popup and window.

- 2026-10-17 review: consolidated review lineage review-516c3c0d347695b4 approved and acknowledged. Suggestions checked and dismissed: focusSearchField() is only called from the `/` key handlers while the surface is open; terms restored programmatically come from the field itself, already capped at 256.
- 2026-10-17 T3 done: the user confirmed search works in the popup and the expanded window on the local build.

## Next step
T4: commit, release v1.10.14, retarget #11673, reply to HANCORE-linux.
