# Transaction limit (issue #7)

## Intent and authority
Fix the hard-stuck transaction history reported in issue #7: at the entry cap every install/update refuses, cleanup preserves everything, and pre-remount successes never revalidate. Adds the bounded configurable limit in Settings (default kept) with a near-limit warning. No auto-deleting anything needing manual review. User requested a PR for the issue; no live installation, deployment or release authorized.

## Safety contract
The limit override is read descriptor-relative from this plugin's own shell.json entry, bounded (8–128) and fail-default; it moves only the capacity threshold, never success proof. Automatic cleanup was dropped in review: deletion stays manual and confirmed, and the archive is never touched automatically. Settings never lets the limit drop below the live active count, so lowering it cannot wedge updates. When the helper cannot read the saved value it enforces the default and Settings names the limit actually in force. UI writes go through the host entry replacement like existing settings.

## Completed work units
- [x] T1 Device-tolerant completed-record validation plus regression tests (merged separately to master, PR hunk dropped on rebase).
- [x] T2 Configurable limit in helper (shell.json read, status/archival) plus tests.
- [x] T3 Model.js dynamic limit validation/labels, settings readers/writers, near-limit helper, floor and fallback helpers plus tests.
- [x] T4 PluginStore limit setting with live floor, both Settings surfaces plus tests.
- [x] T5 README recovery/settings documentation.
- [x] T6 Rebase onto v1.10.10, review fixes, full verification and PR.

## Verification evidence
Recorded in the PR. Node suite, Python suites (except pre-existing PySide6 import failure, identical on clean master), qmllint exit 0, git diff --check clean.
Branch: feat/issue-7-transaction-limit-auto-cleanup.

## Runtime and rollback
Status schema unchanged apart from the limit range (8–128, default 32); lower bound reported at limit + 1. Rollback removes the shell.json key (`transactionLimit`) to restore defaults; code and tests roll back together.
