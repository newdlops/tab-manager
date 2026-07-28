## PLAN

### PLAN_VERSION
v2 — explorer-copy-paste-finder-20260728

### RISK_LEVEL
NORMAL

### GOAL
Make Extended Explorer file copy/paste reliable and Finder-like: copy every normalized selected file and folder as one reusable batch, recursively preserve folder contents and all sources, paste a copied folder beside itself from the keyboard, keep collisions under predictable `copy`/`copy 2` names without overwriting, expose native progress/error states, preserve native clipboard interoperability, and prevent a lossy immediate native mirror from truncating the internal batch.

### CURRENT_BEHAVIOR
- `src/extension.ts` / `activate` creates `tabManagerExplorer` with `canSelectMany: true`. VS Code passes the invoked item as the first command argument and selected items as the second argument.
- `src/explorerCommands.ts` / `tabManager.explorer.copy` now normalizes selected URIs, supplies that normalized batch to `writeClipboardFileUris`, and stores `{ mode: 'copy', uris, mirrored }`.
- `normalizeCopySources` removes exact duplicates and descendants whose selected ancestor already represents their subtree.
- `tabManager.explorer.paste` now uses copy-specific sibling-target resolution and dispatches copy operations through sequential, non-overwriting `copyPaste`; the move branch remains separate.
- `copyPaste` supplies view-scoped progress, stats each source, blocks recursive self-copy, chooses directory-aware Finder-style collision names, catches failures per source, and emits bounded aggregate notifications.
- `resolvePasteSources` still determines external freshness with `clipboard.mirrored && osFiles.length > 0 && !sameUriSet(osFiles, clipboard.uris)`.
- A successful native write can read back only a subset of the normalized internal batch. In that state, `resolvePasteSources` treats the subset as a newer external selection, so progress reports fewer items and stale sources never reach `copyPaste`.
- Current E2E evidence is 25 passing, 1 pending native test, and 2 failures: a normalized four-source batch reports three items, and a valid-plus-missing internal batch emits no missing-source error.
- The conditional native-clipboard test writes a later different external file-plus-folder set after an internal copy and verifies that the external set supersedes the internal set.

### ACCEPTANCE_CRITERIA
- AC-1 — Copy invoked from a multi-selected Explorer context or keyboard selection → capture every unique top-level selected file and folder in stable selection order as one reusable internal copy batch; a selected ancestor suppresses its selected descendants.
- AC-2 — Paste a valid mixed batch into an explicit destination folder → copy every file and folder recursively, leave all sources unchanged, process sources sequentially, and retain internal copy state for repeated paste.
- AC-3 — With a copied non-workspace-root file or directory still selected, invoke Paste without an explicit argument → use its parent as the copy destination; explicit folder/file targets and workspace-root safeguards retain their existing behavior.
- AC-4 — A destination name already exists → never replace or merge it; choose Finder-style `copy`/`copy 2` names with directory-aware extension handling and perform the final copy with `overwrite: false`.
- AC-5 — A source directory would be copied into itself or a descendant → skip it with one native warning, leave it intact, and continue valid batch items.
- AC-6 — A source is missing, unreadable, unsupported, or cannot be written → record its formatted error, continue the batch, keep successful copies, emit one bounded aggregate native error, and retain internal copy state for retry.
- AC-7 — A non-empty copy paste begins → show view-scoped Extended Explorer progress with the internal batch count and per-item reports; full success remains quiet.
- AC-8 — Native clipboard mirroring or reading exposes fewer file URIs than the normalized internal copy batch → a current native set matching the guarded immediate mirror snapshot must not supersede or truncate the internal batch.
- AC-9 — After an internal copy, a later non-empty native URI set differs from both the intended internal set and the captured native mirror snapshot → treat it as a newer external copy batch and paste that external set.
- INV-1 — Existing Cut/Move behavior, including native mirroring, freshness comparison against cut URIs, root filtering, overwrite confirmation, rename execution, self/descendant protection, and clipboard consumption, remains semantically unchanged.
- INV-2 — Existing command IDs, keybindings, menus, TreeView selection, explicit destinations, workspace fallback, and native presentation remain unchanged.
- INV-3 — Copy never renames, deletes, overwrites, merges, or modifies a source.
- INV-4 — Native freshness remains content-based: empty/unavailable native reads fall back internally, a recognized copy mirror representation retains the internal batch, and a later different non-empty native set wins.
- INV-5 — Explorer watcher/cache behavior and unrelated Explorer/tab behavior remain unchanged.

### SCOPE
SCOPE_LOCK: Fix only Extended Explorer file/folder copy and paste so it supports normalized multi-source batches, Finder-like non-destructive duplication, partial failure/retry, and correct reconciliation when the native bridge exposes a lossy immediate mirror.

Authorized product-code edits are limited to `src/explorerCommands.ts` within:
- `ClipboardState`;
- `registerExplorerCommands` registrations for `tabManager.explorer.copy` and `tabManager.explorer.paste`;
- `resolvePasteSources` and `sameUriSet`;
- private copy-specific URI normalization, native-mirror snapshot/subset, paste-target, destination-name, progress, and error-formatting helpers.

Authorized test edits are limited to directly mapped copy/paste cases and nonsemantic fixtures/stubs in `src/test/suite/tabManager.e2e.test.ts`.

`src/osClipboard.ts`, `src/extension.ts`, `src/explorerProvider.ts`, and `package.json` remain inspection/preservation boundaries. Their APIs may be called unchanged but their files must not be edited.

### NON_GOALS
- No native clipboard script, pasteboard-generation, platform-support, polling, timestamp, dependency, or `src/osClipboard.ts` change.
- No Cut/Move behavior change, move collision redesign, clipboard-consumption change, or cut-state decoration.
- No drag/drop, rename, delete, create, reveal, compare, filter, sort, project, watcher, or tab behavior change.
- No replace/merge dialog, destructive overwrite, undo stack, copy history, cancellation engine, or custom recursive filesystem implementation.
- No command, keybinding, menu, package metadata, engine-range, provider, extension API, or generated-artifact change.
- No test weakening, removal, platform-specific bypass, or new public/test hook.
- No general Explorer redesign, custom webview, or new visual system.
- OUT_OF_SCOPE_FINDINGS: `src/explorerProvider.ts` / `ExplorerProvider.handleDrop` has an independent move-only conflict flow — NO ACTION.
- OUT_OF_SCOPE_FINDINGS: native clipboard provenance cannot distinguish two observations with the exact same URI set without a platform generation API — NO ACTION; this amendment preserves the existing URI-set/content model.
- OUT_OF_SCOPE_FINDINGS: the installed `@types/vscode` version is newer than the declared minimum engine — NO ACTION.

### INVARIANTS
- INV-1 — Cut assignment remains `{ mode: 'cut', uris, mirrored }`; it does not capture or compare a copy mirror snapshot.
- INV-2 — Public commands, TreeView focus/selection, workspace-root safeguards, menus, keybindings, and native VS Code UI remain unchanged.
- INV-3 — Copy remains non-destructive, sequential, and best-effort per top-level source, without rollback.
- INV-4 — A copy mirror snapshot is accepted only when the native write succeeded and its immediate readback is a non-empty subset of the normalized internal URI set. Matching either the full intended set or this snapshot resolves to the complete internal batch. A different non-empty set resolves externally.
- INV-5 — Only the two scope-authorized files may contain executor changes; no direct-dependency file may change.

### IMPLEMENTATION_STEPS
1. **CP-1R** — `src/explorerCommands.ts` / normalized copy capture, `ClipboardState`, native mirror snapshot, `resolvePasteSources`, and copy-aware target resolution
   - Acceptance/invariant mapping: AC-1, AC-3, AC-8, AC-9, INV-1, INV-2, INV-4, INV-5
   - Current behavior: Copy normalization and copy-aware target resolution are implemented. Copy stores only the write-success boolean, while `resolvePasteSources` compares the current native set exclusively with the full internal set. A stable lossy native subset therefore falsely supersedes internal state.
   - Edit map:
     - Retain `normalizeCopySources` and `resolveCopyContainer`.
     - Add `nativeMirrorUris?: vscode.Uri[]` to `ClipboardState`.
     - Add one private URI-set subset helper adjacent to `sameUriSet`.
     - In `tabManager.explorer.copy`, immediately read native file URIs only after a successful write and conditionally store the guarded snapshot.
     - Amend only the copy-aware matching condition in `resolvePasteSources`; retain all return shapes and clearing behavior.
     - Update the reconciliation comment to describe full-set and captured-snapshot matching.
   - Change:
     - `writeClipboardFileUris(uris)` must still receive the normalized internal batch.
     - If it returns `false`, perform no additional read and store no snapshot.
     - If it returns `true`, immediately call `readClipboardFileUris()`.
     - Accept the returned array as `nativeMirrorUris` only if its length is greater than zero and every returned URI’s `toString()` occurs in normalized `uris`. This permits full, lossy, and file-only representations while rejecting an unrelated set that raced with the write.
     - Do not append missing internal URIs to the snapshot, normalize it into the full set, or treat an empty read as a snapshot.
     - Store `{ mode: 'copy', uris, mirrored, nativeMirrorUris }`, omitting/using `undefined` for an invalid snapshot.
     - In `resolvePasteSources`, define a recognized internal native representation as either `sameUriSet(osFiles, clipboard.uris)` or, only for copy state with a captured snapshot, `sameUriSet(osFiles, clipboard.nativeMirrorUris)`.
     - `externalIsNewer` is true exactly when `clipboard.mirrored`, `osFiles.length > 0`, and neither recognized comparison matches.
     - When a snapshot matches, return `{ sources: clipboard.uris, move: false, fromInternal: true }`; never return the snapshot as paste sources.
     - When no valid snapshot exists, behavior reduces to the v1/original full-set comparison.
     - Preserve `osFiles.length === 0` internal fallback, `mirrored === false` fallback, external return/clearing, and all cut behavior.
   - Ordered control flow:
     1. Normalize selected copy sources.
     2. Write the normalized batch to the native clipboard.
     3. On write success only, immediately read native file URIs.
     4. Record the readback only if it is a non-empty subset of the normalized internal batch.
     5. On paste, read current native file URIs.
     6. If internal state is absent, use a non-empty native set externally as before.
     7. If native mirroring was unavailable or the current native set is empty, use internal state.
     8. If the current native set equals the intended internal set, use internal state.
     9. For copy state, if it equals the captured immediate snapshot, use the complete internal state.
     10. Otherwise use the current native set as the newer external copy selection.
   - Existing pattern/reference: `sameUriSet`; URI `toString()` identity in `normalizeCopySources`; best-effort contracts of unchanged `readClipboardFileUris` and `writeClipboardFileUris`.
   - Direct dependency impact: `src/osClipboard.ts` public functions are called unchanged. No dependency, platform script, schema, provider, extension API, package, or generated artifact changes.
   - Test specification:
     - Keep the mixed selection expectation at four normalized sources and four progress reports even when the native bridge reads back fewer.
     - Keep the valid-plus-missing batch expectation at one aggregate error and a retained full internal batch; after creating the missing source, retry must copy it and create the next name for the valid source.
     - Keep the conditional native test where a later different external file-plus-folder set supersedes the internal copy.
     - Headless/unavailable native behavior must continue using the internal batch.
     - Existing cut/move and OS freshness tests must pass without altered assertions.
   - Edge cases: Successful write with full readback; successful write with strict subset; file-only readback from mixed URI schemes; empty readback; read failure; unrelated immediate readback; unchanged subset across repeated paste; later full intended set; later different external set; `mirrored === false`; cut state without snapshot.
   - Done when: Internal copy execution always receives the complete normalized batch for either recognized mirror representation, a later different external set still wins, and cut behavior is unchanged.
   - Validate: `npm run check-types`, then the two affected E2E cases, then `npm run test:e2e`.

2. **CP-2** — `src/explorerCommands.ts` / copy-only paste execution, collision naming, progress, and aggregate issues
   - Acceptance/invariant mapping: AC-2, AC-4, AC-5, AC-6, AC-7, INV-1, INV-2, INV-3, INV-4, INV-5
   - Current behavior: The current diff separates copy from move, runs copy sequentially within view-scoped progress, stats each source, uses directory-aware collision naming, copies with `overwrite: false`, isolates per-source failures, and emits bounded warning/error summaries.
   - Edit map: Preserve the current `copyPaste`, `uniqueCopyDestination`, `copyName`, `formatCopyIssue`, and `formatCopyFailures` implementation except for a uniquely required mechanical repair revealed by validation. Do not move reconciliation into the copy loop.
   - Change:
     - Run normalized sources sequentially under `{ location: { viewId: 'tabManagerExplorer' }, title: 'Copying 1 item…' | 'Copying N items…' }`.
     - Report each basename and proportional increment.
     - Stat each source; block directory self/descendant targets; otherwise resolve a free Finder-style destination and call `workspace.fs.copy(..., { overwrite: false })`.
     - Catch stat, name-resolution, and copy failures per source and continue.
     - Emit at most one blocked warning and one failure error after progress.
     - Leave internal copy state intact after full success, partial success, or failure.
     - Preserve external-state clearing and the move branch.
   - Ordered control flow: complete normalized internal batch from CP-1R → progress → per-source report/stat/guard/name/copy or failure → aggregate notifications → retain internal state.
   - Existing pattern/reference: current scoped diff in `copyPaste`; existing `formatOpenError`, `exists`, `isSameOrAncestor`, and refresh progress usage.
   - Direct dependency impact: NONE.
   - Test specification:
     - Mixed files, dotfile, dotted recursive folder, nested-selection suppression, sentinel no-overwrite, repeated naming, and source preservation.
     - Valid-plus-missing partial batch, exactly one error, retry after source recovery, and retained valid-source naming sequence.
     - Existing recursive safety, cut/move, stale-source, watcher, and command-path tests remain green.
   - Edge cases: Empty batch; one/many sources; recursive and dotted directories; dotfiles; existing suffixes; missing source; destination race; self/descendant target; all-failure and partial-success batches; naming exhaustion.
   - Done when: AC-2 and AC-4 through AC-7 remain satisfied after reconciliation is corrected, without copy or move regressions.
   - Validate: `npm run check-types` and `npm run test:e2e`.

3. **CP-3** — `src/test/suite/tabManager.e2e.test.ts` / normalized batch, partial recovery, keyboard target, and native freshness coverage
   - Acceptance/invariant mapping: AC-1 through AC-9 and INV-1 through INV-5
   - Current behavior: The scoped diff adds mixed normalized batch/progress/naming coverage, selected-folder sibling duplication, partial failure/retry, and a file-plus-folder native external batch. Two expectations currently fail only because reconciliation substitutes the lossy native set before copy execution.
   - Edit map:
     - Preserve the expected four-item title and exact four progress reports.
     - Preserve the one-error missing-source assertion and retry assertions.
     - Preserve the selected-folder keyboard scenario.
     - Preserve the later different external file-plus-folder assertion.
     - Do not skip, weaken, reorder around stale selection without necessity, or add native bridge mocks/public hooks.
   - Change: No semantic assertion change is authorized to accommodate the current failure. Only nonsemantic fixture/stub repair is allowed if required by the CP-1R implementation.
   - Ordered control flow: create isolated fixtures → copy normalized selection → paste explicitly or through real selection → assert full internal batch and retained sources → retry → write a later different native batch → assert external supersession.
   - Existing pattern/reference: `withWindowStub`, `waitForExplorerNode`, `itemFor`, `explorerView.reveal`, and the existing conditional native capability skip.
   - Direct dependency impact: NONE.
   - Test specification:
     - `copies normalized mixed Explorer selections with progress and Finder-style names` must receive `Copying 4 items…` and reports for `report.txt`, `folder.with.dot`, `.env`, and `sentinel.txt`.
     - `pastes a selected copied folder beside itself and recovers a partial batch` must emit one error mentioning `recovery-missing.txt`, copy the valid item, retain both internal URIs, and succeed after the missing source is created.
     - `pastes files placed on the OS clipboard by another application` must paste the later external file and recursive folder and must not paste the prior internal file.
     - Existing cut/move and unrelated tests remain unchanged and green.
   - Edge cases: Native bridge available and lossy; bridge unavailable; full readback; stale source omitted by native representation; real TreeView selection; repeated paste; later external batch.
   - Done when: All automated in-host assertions pass without weakening, and native capability is reported as pass or existing conditional skip.
   - Validate: `npm run test:e2e` → zero failures.

### ALLOWED_EXECUTOR_DISCRETION
- Local variable names, import ordering, formatting, and the private subset-helper name are discretionary.
- Nonsemantic test-stub or isolated-fixture form may follow existing local patterns.
- Terra may mechanically repair only its immediately introduced syntax, type, import, or formatting errors using an identical repository pattern.
- The state field behavior, subset guard, immediate read ordering, recognized-set condition, full internal return, external supersession rule, cut boundary, test expectations, changed files, and validations are not discretionary.

### MANDATORY_ESCALATION
- Stop before editing any file other than `src/explorerCommands.ts` or directly mapped cases in `src/test/suite/tabManager.e2e.test.ts`.
- Stop if implementation requires `src/osClipboard.ts`, native scripts, pasteboard generation/change-count access, polling, timestamps, a dependency, a new module, public/test APIs, provider changes, package changes, or generated artifacts.
- Stop if cut state or cut/move reconciliation would need the snapshot behavior.
- Stop if immediate readback cannot be performed through the existing imported best-effort function.
- Stop if a different non-empty external URI set no longer supersedes internal copy state.
- Stop if the expected four-source or missing-source assertions would need weakening/removal.
- Stop if the same implementation step fails twice, the failure cause is uncertain, or validation cannot prove AC-8/AC-9.
- USER_DECISION_REQUIRED before broadening SCOPE_LOCK or changing from URI-set freshness to platform clipboard-generation semantics.

### VALIDATION_PLAN
- Compile/type check: `npm run check-types` → exits 0 with no TypeScript diagnostics.
- Build: `npm run compile` → exits 0 and produces the extension bundle without new warnings.
- Unit: N/A — no separate unit script; private reconciliation is exercised through registered Extension Host command paths.
- Integration: `npm run test:e2e` → exits 0; normalized batch, keyboard sibling copy, collision naming, progress, partial failure/retry, recursive safety, native external freshness, cut/move, watcher, and unrelated existing cases pass.
- Lint/static analysis: no lint script/configuration exists; run `npm run check-types` and `git diff --check`.
- Diff/scope review: `git diff -- src/explorerCommands.ts src/test/suite/tabManager.e2e.test.ts` maps every hunk to AC-1–AC-9 or INV-1–INV-5; `git status --short` shows no executor-created changes outside the two authorized files and no debug output, TODO, bypass, or temporary workaround.
- Manual functional scenario: in a disposable Extension Development Host workspace, copy several files plus a recursive folder, paste repeatedly, and verify the complete batch and exact collision names. Copy a folder and paste without changing selection to verify sibling duplication. Force a stale-source batch and verify one bounded error plus successful retry.
- Manual Finder interoperability: verify file-plus-folder round trips in both directions. A later different Finder selection must supersede internal copy state. If the conditional E2E native test skips, this manual check is mandatory.
- Manual visual QA: inspect native view-scoped progress and bounded errors in narrow, normal, and wide desktop sidebar widths. Mobile/tablet browser viewports remain inapplicable.
- Performance/data/authorization: exercise at least 25 small top-level items plus a nested directory; verify sequential completion, responsive native progress, unchanged sources/sentinels, and no rename/delete calls from copy.
- Review gate: read-only final Sol review is mandatory because the plan is amended and reconciliation data semantics changed. Supply v1, v2, final diff, all automated results, skip evidence, and manual evidence.

### ROLLBACK_OR_RECOVERY
N/A for NORMAL risk. If validation fails, stop and retain diagnostic fixtures. Revert only executor-authored mapped hunks through the workflow; do not reset or delete user data.

### OPEN_ASSUMPTIONS
- Verified: `readClipboardFileUris` and `writeClipboardFileUris` are already imported into `src/explorerCommands.ts`, are best-effort, and require no API or dependency change.
- Verified: the observed native bridge can return a non-empty subset after reporting write success.
- Verified: existing freshness is URI-set/content based, not pasteboard-generation based; exact equal observed sets are not distinguished by age.
- Verified: accepting only a non-empty readback subset prevents an unrelated raced readback from being blessed as the internal mirror representation.
- Verified: comparison against both the intended internal set and captured mirror snapshot preserves full readback behavior as well as lossy readback behavior.
- Verified: the current CP-3 tests plus the later different external file-plus-folder case directly exercise both sides of the amended condition.
- Remaining blocker: NONE.

### PLAN_COMPLETENESS_SELF_CHECK
- Remaining meaningful executor decisions inside SCOPE_LOCK: NONE
- Planned changes or tests without an AC-*/INV-* mapping: NONE
- Unspecified direct-caller, error, edge-case, or test behavior inside SCOPE_LOCK: NONE
- OUT_OF_SCOPE_FINDINGS converted into work: ZERO
- Unauthorized scope expansion: ZERO
- Evidence that each acceptance criterion maps to implementation and validation: AC-1/AC-3 → CP-1R and keyboard/multi-selection E2E; AC-2/AC-4/AC-5/AC-6/AC-7 → CP-2 and copy-path E2E; AC-8 → CP-1R guarded snapshot plus four-item and partial-failure E2E; AC-9 → CP-1R different-set branch plus native external file-and-folder E2E; INV-1–INV-5 → copy-only state field, unchanged cut branch/dependencies, complete E2E suite, diff review, and mandatory final Sol review.
