# Transaction limit and auto-cleanup (issue #7)

## Intent and authority
Fix the hard-stuck transaction history reported in issue #7: at the entry cap every install/update refuses, cleanup preserves everything, and pre-remount successes never revalidate. Add the two feature asks: a bounded configurable limit in Settings (default kept) and opt-in automatic cleanup of proven-success history with a near-limit warning. No auto-deleting anything needing manual review. User requested a PR for the issue; no live installation, deployment or release authorized.

## Safety contract
Stored device numbers are evidence, not assertions: identity is the inode plus current co-location, with mount/anchor rechecks unchanged. The limit override is read descriptor-relative from this plugin's own shell.json entry, bounded (8–128) and fail-default; it moves only the capacity threshold, never success proof. Automatic cleanup reuses the exact manual deletion primitive and eligibility; edge-triggered once per crossing into the margin, never retried. UI writes go through the host entry replacement like existing settings.

## Completed work units
- [x] T1 Device-tolerant completed-record validation plus regression tests.
- [x] T2 Configurable limit in helper (shell.json read, status/archival) plus tests.
- [x] T3 Model.js dynamic limit validation/labels, settings readers/writers, near-limit helper plus tests.
- [x] T4 PluginStore settings, auto-cleanup edge trigger, both Settings surfaces plus tests.
- [x] T5 README recovery/settings documentation.
- [x] T6 Full verification and PR.

## Verification evidence
Recorded in the PR. Node suite, Python suites (except pre-existing PySide6 import failure, identical on clean master), qmllint exit 0, git diff --check clean.
Branch: feat/issue-7-transaction-limit-auto-cleanup.

## Runtime and rollback
Status schema unchanged apart from the limit range (8–128, default 32); lower bound reported at limit + 1. Rollback removes the shell.json keys (`transactionLimit`, `autoCleanupCompleted`) to restore defaults; code and tests roll back together.
