## PLAN

### PLAN_VERSION
v3 — explorer-copy-paste-finder-20260728-remainder

### RISK_LEVEL
NORMAL

### GOAL
Complete the existing Extended Explorer copy/paste work by correcting two E2E paste-target fixtures to use live Explorer provider nodes, then validate the already implemented normalized batching, non-destructive copy execution, partial recovery, keyboard sibling duplication, and native clipboard reconciliation without further product-code changes.

### CURRENT_BEHAVIOR
- The v2 `src/explorerCommands.ts` diff implements normalized copy batches, copy-aware sibling targeting, sequential non-overwriting copy execution, Finder-style collision names, progress, bounded aggregate issues, retained copy state, and guarded native-mirror snapshot reconciliation.
- `npm run check-types` passes.
- The latest `npm run test:e2e` reports 26 passing and 2 failures. The former three-item reconciliation mismatch and missing-error mismatch are resolved, and the native external file-plus-folder test passes.
- `src/test/suite/tabManager.e2e.test.ts` / `itemFor` creates a plain `vscode.TreeItem` and assigns only `resourceUri`.
- `src/explorerCommands.ts` / `resolveCopyContainer` delegates an explicit trigger to `resolveContainer`.
- `resolveContainer` recognizes actual `WorkspaceFolderNode`, `DirectoryNode`, and `FileNode` instances. Any other object falls through to workspace-folder selection; with one workspace, the returned target is the workspace root.
- The mixed-batch test passes `itemFor(target)` to three paste invocations, so its files are copied to the workspace root rather than `copy-batch/target`.
- The partial-recovery test passes `itemFor(target)` to both paste invocations, so its valid file is copied to the workspace root rather than `copy-keyboard/recovery-target`.
- Existing passing paste cases use live nodes returned from `waitForExplorerNode` or real TreeView selection.
- The native external file-plus-folder case passed with a live target node, directly proving that `workspace.fs.copy(..., { overwrite: false })` copies files and recursive directories in this Extension Host.

### ACCEPTANCE_CRITERIA
- AC-1 — Multi-selected copy sources → retain every unique top-level source in stable order and suppress selected descendants of selected directories.
- AC-2 — An explicit live directory target receives a valid mixed batch → all files and recursive directories are created inside that directory and sources remain unchanged.
- AC-3 — Argument-less paste with a copied selected file or directory → duplicate beside the selected source while retaining workspace-root safeguards.
- AC-4 — Existing destination names → use deterministic Finder-style copy names without overwrite or merge.
- AC-5 — Recursive self/descendant copy → skip the blocked source, warn once, and continue valid sources.
- AC-6 — Valid-plus-missing internal batch pasted to a live directory target → copy the valid item, emit one bounded error for the missing item, retain internal state, and copy both on retry after recovery.
- AC-7 — Non-empty copy paste → report the complete normalized batch through view-scoped progress.
- AC-8 — Current native URI set matches the guarded immediate mirror snapshot → retain the complete internal batch.
- AC-9 — Later non-empty native URI set differs from both recognized internal representations → paste the external set.
- INV-1 — Cut/Move semantics remain unchanged.
- INV-2 — Explicit target handling continues to use actual provider nodes and existing `resolveContainer` type semantics.
- INV-3 — Copy remains sequential, non-destructive, non-overwriting, and best-effort.
- INV-4 — v2 native mirror-snapshot and external-freshness semantics remain unchanged.
- INV-5 — No unrelated Explorer, provider, clipboard-bridge, package, or tab behavior changes.

### SCOPE
SCOPE_LOCK remains unchanged: fix only Extended Explorer file/folder copy and paste so it supports normalized multi-source batches, Finder-like non-destructive duplication, partial failure/retry, and correct reconciliation when the native bridge exposes a lossy immediate mirror.

The current product-code boundary remains `src/explorerCommands.ts` within:
- `ClipboardState`;
- `tabManager.explorer.copy` and `tabManager.explorer.paste`;
- `resolvePasteSources` and `sameUriSet`;
- private copy-specific normalization, native-mirror, target, naming, progress, and issue helpers.

No further product-code edit is planned or authorized by this remainder.

The only remaining authorized edits are nonsemantic target-fixture corrections in these two cases in `src/test/suite/tabManager.e2e.test.ts`:
- `copies normalized mixed Explorer selections with progress and Finder-style names`;
- `pastes a selected copied folder beside itself and recovers a partial batch`.

`src/osClipboard.ts`, `src/extension.ts`, `src/explorerProvider.ts`, `package.json`, all other tests, and git state remain unchanged.

### NON_GOALS
- No change to `copyPaste`, `workspace.fs.copy` options, destination naming, error formatting, progress, or clipboard retention.
- No change to `resolveCopyContainer`, `resolveContainer`, `uriOf`, or acceptance of arbitrary `TreeItem.resourceUri` values as paste targets.
- No diagnostic notification capture, logging, debug output, temporary assertions, public/test hooks, new helper, dependency, native script, platform behavior, provider behavior, or package change.
- No test weakening, skip, removal, changed expected count, changed destination, or tolerance for workspace-root copies.
- No Cut/Move, drag/drop, rename, delete, watcher, filter, sort, project, or tab change.
- OUT_OF_SCOPE_FINDINGS: plain `TreeItem` paste targets fall back to the workspace root — NO ACTION in product code; real command invocation supplies provider nodes.
- OUT_OF_SCOPE_FINDINGS: native pasteboard-generation semantics remain outside scope — NO ACTION.
- OUT_OF_SCOPE_FINDINGS: unrelated Explorer/provider behavior — NO ACTION.

### INVARIANTS
- INV-1 — Preserve the current `src/explorerCommands.ts` diff exactly unless validation reveals a new mismatch and Sol authorizes it.
- INV-2 — A test for explicit paste into a directory must pass a live provider node for that directory.
- INV-3 — Synthetic `itemFor` values remain limited to command inputs whose implementation intentionally consumes `resourceUri`, including selected copy sources.
- INV-4 — Preserve all existing assertions and fixture paths; only replace the explicit target arguments and add the live-node bindings required for them.
- INV-5 — Do not modify files outside the two authorized scope files, and make no further product-code edit during this remainder.
- INV-6 — Retain v2 internal/native reconciliation and existing cut/move behavior unchanged.

### IMPLEMENTATION_STEPS
1. **RP-1** — `src/test/suite/tabManager.e2e.test.ts` / mixed normalized-batch target fixture
   - Acceptance/invariant mapping: AC-1, AC-2, AC-4, AC-7, AC-8, INV-2, INV-3, INV-4, INV-5
   - Current behavior: The test creates `copy-batch/target`, refreshes the provider, but invokes paste three times with `itemFor(target)`. That object is not a provider `DirectoryNode`, so target resolution falls back to the workspace root.
   - Edit map:
     - Immediately after fixture creation and `api.explorerProvider.refresh()`, obtain `const targetNode = await waitForExplorerNode(api, 'target', base)`.
     - Replace the `itemFor(target)` argument in the progress-stubbed initial paste with `targetNode`.
     - Replace both later `itemFor(target)` repeated-paste arguments with the same `targetNode`.
     - Leave the copy-source array’s six `itemFor(...)` entries unchanged.
   - Change: Exercise the real explicit-directory command contract without changing product behavior or expected results.
   - Ordered control flow: create target/sources → refresh provider → obtain live `target` node under `copy-batch` → copy synthetic multi-selection sources → paste to live node under progress stub → assert exact files/progress → paste twice more to the same live node → assert collision names and unchanged sources.
   - Existing pattern/reference: the native external clipboard test obtains `targetNode` through `waitForExplorerNode(api, 'target', base)` before explicit paste; recursive-copy tests likewise pass live provider nodes.
   - Direct dependency impact: NONE.
   - Test specification:
     - Keep exact progress options `{ location: { viewId: 'tabManagerExplorer' }, title: 'Copying 4 items…' }`.
     - Keep reports `['report.txt', 'folder.with.dot', '.env', 'sentinel.txt']`.
     - Keep all target contents, recursive-content, no-flattening, sentinel no-overwrite, repeated-name, and source-preservation assertions unchanged.
   - Edge cases: Provider refresh timing; stable node reuse across repeated paste; watcher refresh after copies. The node retains its provider class and target URI, so command target resolution remains deterministic.
   - Done when: Every asserted destination exists under `copy-batch/target`, no copied source is flattened or mutated, and progress/naming assertions are unchanged.
   - Validate: `npm run check-types` followed by `npm run test:e2e` after RP-2, because the repository exposes no targeted E2E script.

2. **RP-2** — `src/test/suite/tabManager.e2e.test.ts` / partial-recovery target fixture
   - Acceptance/invariant mapping: AC-2, AC-6, AC-8, INV-2, INV-3, INV-4, INV-5
   - Current behavior: The test creates `copy-keyboard/recovery-target`, refreshes the provider, then invokes both partial-batch paste attempts with `itemFor(target)`. Target resolution therefore uses the workspace root. The earlier selected-folder sibling-copy portion already succeeds.
   - Edit map:
     - After creating `recovery-target` and `recovery-valid.txt` and refreshing the provider, obtain `const recoveryTargetNode = await waitForExplorerNode(api, 'recovery-target', base)`.
     - Replace the `itemFor(target)` argument inside the `showErrorMessage` stubbed paste with `recoveryTargetNode`.
     - Replace the retry paste’s `itemFor(target)` argument with `recoveryTargetNode`.
     - Keep `[itemFor(valid), itemFor(missing)]` as the copy-source selection.
   - Change: Exercise partial failure and retry against the intended live directory target while preserving the exact internal source batch and assertions.
   - Ordered control flow: complete selected-folder sibling-copy assertions → create recovery target/valid source → refresh provider → obtain live recovery target node → copy valid-plus-missing source fixtures → paste to live node while capturing the required aggregate error → assert valid destination and absent missing destination → create missing source → paste retained batch to the same live node → assert recovered destination and next valid copy name.
   - Existing pattern/reference: `waitForExplorerNode` use in the same test’s selected-folder path and the passing native external target path.
   - Direct dependency impact: NONE.
   - Test specification:
     - Preserve `errors.length === 1`.
     - Preserve the error requirement for `recovery-missing.txt`.
     - Preserve valid destination content, missing-destination absence, recovered content, and `recovery-valid copy.txt` assertions.
   - Edge cases: Existing TreeView selection from the sibling-copy portion does not affect resolution because the explicit live trigger takes precedence.
   - Done when: The first paste creates `recovery-valid.txt` under `recovery-target` and reports the missing source once; retry creates the missing source destination and the valid source’s next unique name.
   - Validate: `npm run check-types`, then `npm run test:e2e`.

3. **RV-1** — repository validation and scope review
   - Acceptance/invariant mapping: AC-1 through AC-9 and INV-1 through INV-6
   - Current behavior: Type checking passes; the latest complete E2E run has only the two target-fixture failures.
   - Edit map: NONE after RP-1/RP-2. This is validation only.
   - Change: Run every remaining automated gate and inspect the final scoped diff. Do not repair a new semantic failure without another Sol decision.
   - Ordered control flow:
     1. Run `npm run check-types`.
     2. Run `npm run compile`.
     3. Run `npm run test:e2e`.
     4. Run `git diff --check`.
     5. Inspect `git diff -- src/explorerCommands.ts src/test/suite/tabManager.e2e.test.ts`.
     6. Inspect `git status --short`.
     7. Record native test pass/skip and all unavailable manual checks accurately.
     8. Submit v1, v2, v3, final diff, and validation evidence for read-only final Sol review.
   - Existing pattern/reference: v2 `VALIDATION_PLAN` and protocol completion gates.
   - Direct dependency impact: NONE.
   - Test specification: All 28 non-skipped E2E cases must pass; only the existing native capability condition may skip its test.
   - Edge cases: A native capability skip requires the existing manual Finder interoperability check; unavailable manual or visual checks must be reported, not inferred.
   - Done when: Automated gates pass, scope review is clean, required manual limitations are documented, and final Sol review returns `PASS`.
   - Validate: commands listed under `VALIDATION_PLAN`.

### ALLOWED_EXECUTOR_DISCRETION
- Local names `targetNode` and `recoveryTargetNode` may differ.
- Formatting and line wrapping are discretionary.
- Terra may mechanically repair only its own immediately introduced syntax, type, import, or formatting error using the identical local test pattern.
- Target acquisition timing, target lookup parent, paste argument replacements, unchanged source fixtures, assertions, product code, files, and validation commands are not discretionary.

### MANDATORY_ESCALATION
- Stop before any further edit to `src/explorerCommands.ts`.
- Stop before editing a test outside the two named cases or any repository file outside the existing SCOPE_LOCK.
- Stop if `waitForExplorerNode(api, 'target', base)` or `waitForExplorerNode(api, 'recovery-target', base)` cannot return a live provider node.
- Stop if either repaired case still fails, if `workspace.fs.copy` reports an error with a live target, or if a new uncertain cause appears.
- Stop if passing requires changing an expected count, destination, error assertion, retry assertion, skip condition, product target rule, native reconciliation, or cut/move behavior.
- Stop if validation requires diagnostics, a public hook, provider/native-script/package changes, a dependency, or an unplanned file.
- USER_DECISION_REQUIRED before broadening SCOPE_LOCK for any reason.

### VALIDATION_PLAN
- Compile/type check: `npm run check-types` → exits 0 with no TypeScript diagnostics.
- Build: `npm run compile` → exits 0 and produces the extension bundle without new warnings.
- Unit: N/A — no separate unit-test script.
- Integration: `npm run test:e2e` → exits 0; repaired mixed-batch and partial-recovery cases pass, the native external file-plus-folder case passes or uses only its existing capability skip, and all existing cases remain green.
- Lint/static analysis: no lint script/configuration exists; `npm run check-types` and `git diff --check` must pass.
- Diff/scope review: `git diff -- src/explorerCommands.ts src/test/suite/tabManager.e2e.test.ts` maps every hunk to AC-1–AC-9 or INV-1–INV-6; `git status --short` shows no executor-created product/test changes outside the authorized files and no debug output, TODO, bypass, or temporary workaround.
- Manual functional scenario: in a disposable Extension Development Host, verify multi-file/recursive-folder paste, repeated naming, sibling duplication, and stale-source retry.
- Manual Finder interoperability: verify file-plus-folder round trips and later external-selection supersession. Mandatory if the native E2E case skips.
- Manual visual QA: verify native view-scoped progress and bounded errors at narrow, normal, and wide desktop sidebar widths; report unavailable checks explicitly.
- Performance/data/authorization: verify a disposable 25-item-plus-recursive-folder batch remains sequential, non-destructive, and non-overwriting; no auth boundary exists.
- Review gate: mandatory read-only final Sol review with v1, v2, this v3 remainder, final diff, automated evidence, native pass/skip status, and manual evidence or limitations.

### ROLLBACK_OR_RECOVERY
N/A for NORMAL risk. If validation fails, stop and preserve diagnostic evidence. Revert only executor-authored mapped test-fixture changes through the workflow; do not reset git state or delete user data.

### OPEN_ASSUMPTIONS
- Verified: `itemFor` returns a plain `vscode.TreeItem`, not an Explorer provider node.
- Verified: `resolveContainer` ignores a plain `TreeItem.resourceUri` and falls back to the single workspace root.
- Verified: `waitForExplorerNode` traverses `api.explorerProvider.getChildren` and returns the provider’s live node instance.
- Verified: explicit live target nodes take precedence over current selection in `resolveCopyContainer`.
- Verified: the passing native external file-plus-folder case exercises `workspace.fs.copy(..., { overwrite: false })` with a live directory target.
- Verified: no CP-2 product repair or diagnostic mechanism is required.
- Remaining blocker: NONE.

### PLAN_COMPLETENESS_SELF_CHECK
- Remaining meaningful executor decisions inside SCOPE_LOCK: NONE
- Planned changes or tests without an AC-*/INV-* mapping: NONE
- Unspecified direct-caller, error, edge-case, or test behavior inside SCOPE_LOCK: NONE
- OUT_OF_SCOPE_FINDINGS converted into work: ZERO
- Unauthorized scope expansion: ZERO
- Evidence that each acceptance criterion maps to implementation and validation: AC-1/AC-2/AC-4/AC-7/AC-8 → RP-1 plus complete E2E; AC-2/AC-6/AC-8 → RP-2 plus complete E2E; AC-3/AC-5/AC-9 and INV-1/INV-3/INV-4/INV-5/INV-6 → unchanged v2 product implementation plus complete E2E/diff review; INV-2 → both live target-node fixture repairs; final completion → RV-1 and mandatory read-only final Sol review.
