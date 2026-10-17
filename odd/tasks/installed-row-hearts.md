# Installed row hearts

## Objective

Show the Marketplace heart count next to the GitHub star count on each row of the expanded window's left (installed) list.

## Problem / why

The left list rows show GitHub stars from the catalog listing, but not Marketplace hearts, even though the catalog already carries `marketplaceHearts` and the Browse cards and details panes show both.

## Scope

- `Model.js`: a hearts-by-id map and a row heart label, mirroring `catalogStarsById` / `rowStarLabel`.
- `PluginStore.qml`: expose `heartsById`.
- `Expanded.qml`: pass the heart label to both `InstalledListRow` repeaters (installed and built-in).
- `InstalledListRow.qml`: render a red heart and count after the gold star, same look as `CatalogCard.qml`.
- Tests in `test/model.test.mjs`.

Out of scope: starring or hearting actions (open PR #14), the popup panel.

## Constraints

- Unknown or malformed counts show nothing (never zero); a real zero may show.
- Ids are untrusted property names: null-prototype map, own-key lookup.
- Name elision must account for the extra metrics width.

## Acceptance criteria

- A row whose listing has hearts shows the heart and formatted count (`1.2k` style).
- A row with no listing, or no hearts value, shows no heart.
- Stars-only and hearts-only rows both lay out correctly.

## Delivery

Strategy: `ask-on-risk`. Forecast: about 100 authored changed lines, single PR.

## Tasks

- [x] T1: Hearts on installed rows (model, store, row, tests). Route: delegated (writer trigger: 3+ non-trivial files).

## Progress / evidence

- Branch `feat/installed-row-hearts` from `fef1823`.
- T1 RED: `node --test test/` failed loading `test/model.test.mjs` with `ReferenceError: catalogHeartsById is not defined` (106/107 files pass).
- T1 GREEN: `node --test test/`: 413 pass, 0 fail (new test `catalogHeartsById joins Marketplace hearts onto installed rows by id`, row/store/Expanded wiring assertions extended).
- T1 GREEN: `QT_QPA_PLATFORM=offscreen QML_DISABLE_DISK_CACHE=1 python3 -B -m unittest discover -s test -p 'test_*.py'`: Ran 180, OK.
- T1 design: shared `catalogCountById` / `rowCountLabel` helpers back both stars and hearts; the row's star and heart sit in one right-anchored `countsRow`, and name elision uses `countsWidth`.

- T1 commit `b44582c`. Spot check: `node --test test/` 413/413.
- T1 review, first attempt: assess risk `high` (process_boundary signal in Model.js). Preflight and START stopped with `managed_assets_outdated` because `gentle-ai sync --agent claude-code` failed on a missing Pi MCP adapter. The review was unavailable at that point, not skipped; it ran later (below).

- T1 fix: live test showed no stars or hearts. `countsRow.visible` bound to its children's `visible`, which reads false while the parent is hidden, so the row never reappeared after starting hidden (catalog not loaded). Now keyed off `root.stars`/`root.hearts`. RED: source assertion failed (306/307); GREEN: `node --test test/` 413/413.

- Live check (2026-10-17): user confirmed stars and hearts show in the expanded Installed list on `1283b2e`.

- Native review (2026-10-17): consent granted, 4 lenses on `fef1823..211c739`, approved and acknowledged (lineage `review-1eab16fb7da3832e`). Re-reviewed after a doc-only commit (`fef1823..1f84101`, lineage `review-a2d16a7cb044b873`), approved and acknowledged. Advisory only: rename `starLabel` to a neutral count formatter, de-duplicate the star/heart Row blocks, replace fixed-width source slices in tests, add an offscreen QML render test for the counts row.

## Next step

Done. Squash-merged to master and released in v1.10.12. Follow-ups from the advisory findings: offscreen QML render test for `countsRow`, neutral name for `starLabel`, shared count Row component, no fixed-width source slices in tests.
