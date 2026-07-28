## PLAN

### PLAN_VERSION
v1 — explorer-copy-paste-finder-20260728

### RISK_LEVEL
NORMAL

### GOAL
Make Extended Explorer file copy/paste reliable and Finder-like: copy all selected files and folders as one batch, recursively preserve folder contents and all sources, paste a copied folder beside itself when using the keyboard, keep every collision under a predictable `copy`/`copy 2` name without overwriting, expose native progress/error states, and preserve existing OS-clipboard interoperability.

### CURRENT_BEHAVIOR
- `src/extension.ts` / `activate` creates `tabManagerExplorer` with `canSelectMany: true`. The VS Code `TreeViewOptions.canSelectMany` contract passes the invoked item as the first command argument and all selected items as the second argument.
- `src/explorerCommands.ts` / `registerExplorerCommands` already accepts `(node, items)` for `tabManager.explorer.copy`; `selectedItems` uses the complete `items` array for context-menu multi-selection and `filesView.selection` for keyboard invocation. `src/osClipboard.ts` / `writeClipboardFileUris` also serializes every supplied file URI, so the selection and native-clipboard foundations already support batches.
- The copy command currently stores the raw URI list without removing duplicate or parent/descendant selections.
- `src/explorerCommands.ts` / `tabManager.explorer.paste` resolves an argument-less keyboard paste with `resolveContainer(selectedNodes()[0])`. A selected directory resolves to itself. Therefore `Cmd/Ctrl+C`, then `Cmd/Ctrl+V` while the copied directory remains selected targets the source directory; `isSameOrAncestor` warns and no sibling copy is created. With a mixed selection whose first item is a directory, the same rule can incorrectly make that source directory the destination for the other selected items.
- The copy branch does process `sources` sequentially and `vscode.workspace.fs.copy` recursively copies folders, but collision handling calls `uniqueDestination` without knowing whether the source is a file or directory. A dotted directory is treated as though its suffix were a file extension, and an already suffixed name such as `report copy.txt` becomes `report copy copy.txt` instead of `report copy 2.txt`.
- The copy branch preselects a unique path but still calls `vscode.workspace.fs.copy(..., { overwrite: true })`, leaving a race window in which a newly created destination could be overwritten.
- Multi-item failures currently emit one notification per failed item and there is no pending/progress state. Successful earlier items remain, so the current operation is already best-effort rather than transactional.
- `src/test/suite/tabManager.e2e.test.ts` covers a single-file duplicate, one recursive folder copy, self/descendant protection, stale-source handling, and one external OS-clipboard file. It does not cover a real selected-folder keyboard paste, a mixed file/folder selection batch, nested-selection normalization, repeated Finder-style names, partial batch recovery, copy progress, or multiple native clipboard sources.

### ACCEPTANCE_CRITERIA
- AC-1 — Copy invoked from a multi-selected Explorer context or keyboard selection → capture every unique top-level selected file and folder in stable selection order as one reusable copy batch; if both a directory and one of its descendants are selected, copy only the directory tree and do not also flatten the descendant into the destination.
- AC-2 — Paste a valid mixed batch into an explicit destination folder → copy every file and folder, including recursive folder contents, leave every source unchanged, process sources sequentially, and retain the internal copy clipboard for repeated paste.
- AC-3 — With a copied non-workspace-root file or directory still selected, invoke Paste without an explicit command argument → use that selected source’s parent as the destination so a folder is duplicated beside itself; an explicit folder target must still paste inside that folder, an explicit file target must still use its parent, and workspace-folder roots must not cause writes outside the workspace.
- AC-4 — A destination name already exists, including repeated pastes and same-parent duplication → never replace or merge it; choose `name copy.ext`, then `name copy 2.ext`, while treating a dotted directory as `folder.with.dot copy` and a dotfile as `.env copy`; perform the final filesystem copy with `overwrite: false`.
- AC-5 — A source directory would be copied into itself or a descendant → skip that source with one native warning, leave it intact, and continue copying any other valid batch sources.
- AC-6 — A source is missing, unreadable, unsupported by its filesystem provider, or cannot be written to the destination → record that item’s formatted error, continue the remaining batch, keep successful copies, show one bounded aggregate native error after the batch, and leave the internal copy clipboard available for retry.
- AC-7 — A non-empty copy paste begins → show VS Code-native, view-scoped Extended Explorer progress with the batch count and per-item reports; completion remains quiet on full success, empty/no-target/no-clipboard paths remain non-blocking no-ops, and no new custom visual language is introduced.
- AC-8 — Multiple files/folders arrive from Finder or another supported native file clipboard, or are copied from Extended Explorer to the native clipboard → retain all top-level sources and recursive folder behavior; unavailable native clipboard tools must continue degrading to the internal clipboard without breaking Explorer copy/paste.
- INV-1 — Existing Cut/Move behavior, including modifiable-root filtering, move conflict confirmation, rename-based execution, self/descendant protection, and clipboard consumption, remains semantically unchanged.
- INV-2 — Existing command IDs, keybindings, menus, TreeView multi-selection, explicit destination resolution, single-/multi-root fallback, and native Explorer tree styling remain unchanged.
- INV-3 — Copy must never call rename/delete, overwrite an existing destination, merge into an existing directory, or modify a source.
- INV-4 — Existing external-clipboard freshness reconciliation in `resolvePasteSources`, internal fallback when native clipboard tools are unavailable, and non-`file` workspace URI support remain unchanged.
- INV-5 — Explorer watcher/cache behavior and unrelated file commands, drag/drop, filtering, sorting, decorations, and tab management remain unchanged.

### SCOPE
SCOPE_LOCK: Fix only Extended Explorer file/folder copy and paste so it reliably supports multiple selected sources and Finder-like non-destructive duplication. The only product-code edits authorized are `src/explorerCommands.ts` within `registerExplorerCommands`’s `tabManager.explorer.copy` and `tabManager.explorer.paste` registrations and their private copy-specific URI normalization, paste-target, destination-name, progress, and error-formatting helpers. The only test edits authorized are the directly mapped copy/paste cases and nonsemantic test stubs/fixtures in `src/test/suite/tabManager.e2e.test.ts`.

Direct dependencies are inspection/preservation boundaries only: `src/extension.ts` / `activate` TreeView configuration; `src/explorerProvider.ts` / `WorkspaceFolderNode`, `DirectoryNode`, `FileNode`, `baseName`, `parentUri`, and watcher-driven refresh; `src/osClipboard.ts` / `readClipboardFileUris` and `writeClipboardFileUris`; and `package.json` copy/paste commands, menus, keybindings, scripts, and VS Code engine declaration. They must not be changed unless a Sol decision proves the locked outcome cannot otherwise be met.

### NON_GOALS
- No Cut/Move behavior change, move collision redesign, clipboard-consumption change, or cut-state decoration.
- No drag/drop, rename, delete, create, reveal, compare, filter, sort, project, or tab behavior changes.
- No replace/merge dialog, destructive copy overwrite, undo stack, copy history, pause/cancel engine, custom recursive filesystem implementation, or new filesystem dependency.
- No changes to native clipboard platform scripts, supported platforms, command IDs, keybindings, context-menu layout, package metadata, or engine range.
- No general Explorer redesign, new component/token system, custom webview, responsive/mobile UI, or design document.
- OUT_OF_SCOPE_FINDINGS: `src/explorerProvider.ts` / `ExplorerProvider.handleDrop` has an independent move-only conflict flow — NO ACTION.
- OUT_OF_SCOPE_FINDINGS: `package.json` allows the Paste command to remain visible without an internal clipboard context so external Finder/File Explorer clipboard content can still be pasted — NO ACTION.
- OUT_OF_SCOPE_FINDINGS: the installed `@types/vscode` version is newer than the declared minimum engine, but the required `workspace.fs.copy` and TreeView multi-selection contracts exist at the declared VS Code 1.85 API level — NO ACTION.

### INVARIANTS
- INV-1 — Preserve the existing Cut/Move branch’s target rules, confirmation text/actions, overwrite behavior, error handling, source mutation, and internal clipboard consumption.
- INV-2 — Preserve public commands, menu/keybinding contributions, TreeView selection/focus behavior, workspace-root safeguards, and native VS Code presentation.
- INV-3 — Copy is non-destructive and best-effort per top-level source: no overwrite, merge, rename, delete, or rollback of successful earlier copies.
- INV-4 — Preserve native OS clipboard reconciliation and internal fallback; copy-specific source normalization must produce the same normalized URI batch for internal state and native mirroring.
- INV-5 — Change only the two scope-authorized files; do not alter Explorer provider cache/watch logic or unrelated tests.

### IMPLEMENTATION_STEPS
1. **CP-1** — `src/explorerCommands.ts` / `registerExplorerCommands`, `tabManager.explorer.copy`, `tabManager.explorer.paste`, and new private `normalizeCopySources` / copy paste-container helper
   - Acceptance/invariant mapping: AC-1, AC-3, AC-8, INV-1, INV-2, INV-4, INV-5
   - Current behavior: `tabManager.explorer.copy` stores `selectedUris(node, items)` verbatim. `tabManager.explorer.paste` resolves both copy and move targets with `resolveContainer(node ?? selectedNodes()[0])`; a selected `DirectoryNode` therefore becomes its own destination. `selectedItems` itself already follows the VS Code multi-selection argument contract and must be retained.
   - Edit map: In the copy registration, normalize `selectedUris(node, items)` before calling `writeClipboardFileUris` and assigning `clipboard`. Near `isSameOrAncestor`, add one stable, copy-only URI normalizer. Before target resolution in the paste registration, destructure `sources`, `move`, and `fromInternal`; route only `move === false` through a copy-specific container resolver, leaving move target resolution on the existing expression. Do not change `selectedItems`, `selectedNodes`, `selectedUris`, `uriOf`, or `resolveContainer` semantics.
   - Change: `normalizeCopySources` must first remove exact duplicate URI strings while retaining first occurrence order, then remove a candidate when another selected URI is its strict ancestor according to the existing URI-tree boundary rule. Use the normalized list for both native clipboard mirroring and internal `ClipboardState`, so `sameUriSet` continues comparing the same batch. Apply the same normalizer at copy paste execution to sanitize external OS clipboard batches.
     
     The copy-specific container resolver must accept the explicit trigger node, the current primary selected node, and normalized sources:
     - Explicit trigger present → delegate unchanged to `resolveContainer(trigger)`.
     - No explicit trigger and no selected node → delegate unchanged to `resolveContainer(undefined)`.
     - No explicit trigger and selected node is a non-root file/directory whose URI equals one of the copied sources → return `parentUri(selectedUri)`.
     - A selected `WorkspaceFolderNode` must still resolve to its workspace root, never its filesystem parent.
     - Otherwise → delegate unchanged to `resolveContainer(selectedNode)`.
     
     Move must continue using `resolveContainer(node ?? selectedNodes()[0])` without copy-specific normalization or sibling-target behavior.
   - Ordered control flow: `resolvePasteSources` → empty check → destructure → if copy, normalize sources and resolve the copy-aware destination; if move, use the existing destination resolution → absent/cancelled workspace target returns with no filesystem operation → dispatch to the unchanged move flow or CP-2 copy flow.
   - Existing pattern/reference: `src/extension.ts` / `activate` (`canSelectMany: true`); `src/explorerCommands.ts` / `selectedItems`, `selectedUris`, `uriOf`, `resolveContainer`, and `isSameOrAncestor`; `src/osClipboard.ts` / `writeClipboardFileUris`.
   - Direct dependency impact: `src/osClipboard.ts` receives the complete normalized URI array through its unchanged public function. `src/extension.ts`, `src/explorerProvider.ts`, and `package.json` require no edit.
   - Test specification: In `src/test/suite/tabManager.e2e.test.ts`, invoke `tabManager.explorer.copy` with `undefined` plus an item array containing files, a directory, that directory’s nested child, and a duplicate item; paste into a target directory and assert only unique top-level outputs exist, the directory contains its nested child, no descendant is flattened at target root, source order is reflected in progress reports, and all sources remain. Separately select a real directory node with `api.explorerView.reveal(..., { select: true, focus: true })`, invoke copy and paste with no arguments, and assert a sibling copy is created rather than a nested self-copy.
   - Edge cases: Empty selection; duplicate item; parent plus descendant; mixed file/folder order; selected copied file; selected copied directory; selected workspace root; explicit directory target; explicit file target; no workspace; multi-root quick-pick cancellation; external clipboard sources not represented by tree nodes.
   - Done when: Context-menu and keyboard source capture are batch-correct (AC-1), a selected copied folder duplicates beside itself without allowing an out-of-workspace root copy (AC-3), native mirroring receives the same normalized list (AC-8/INV-4), and all move and public UI behavior is unchanged (INV-1/INV-2).
   - Validate: `npm run check-types` → zero TypeScript errors for the new private helpers and command branches; proves AC-1, AC-3, AC-8, INV-1, INV-2, and INV-4 structurally.

2. **CP-2** — `src/explorerCommands.ts` / copy-only paste execution, `uniqueDestination`, and new private copy-name/progress/issue helpers
   - Acceptance/invariant mapping: AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, INV-1, INV-2, INV-3, INV-4, INV-5
   - Current behavior: The shared paste loop handles copy and move together. Copy checks self/descendant, obtains a destination through `uniqueDestination(parent, name)`, and executes `workspace.fs.copy` with `overwrite: true`. `uniqueDestination` splits every dotted name as a file, does not increment an existing ` copy` suffix, and falls back to a timestamp after 999 attempts. Failures each create a separate notification and no progress is shown.
   - Edit map: Keep the move branch’s statements and ordering semantically identical. Add a copy-only execution branch/helper called only when `move === false`. Replace the existing copy use of `uniqueDestination` with a directory-aware signature and a simple Finder-style name increment helper. Add bounded aggregate warning/error formatting adjacent to the copy helpers. Preserve the existing post-operation clipboard-clearing condition after both branches.
   - Change: The copy-only helper must:
     - Run the normalized top-level batch sequentially within `vscode.window.withProgress` using `{ location: { viewId: 'tabManagerExplorer' }, title: 'Copying 1 item…' | 'Copying N items…' }`; report each basename and proportional increment. Do not advertise cancellation because `workspace.fs.copy` cannot cancel an in-flight recursive directory copy.
     - `stat` each source before naming so directories, dotted directories, files, dotfiles, symlink-directory flags, and stale sources are handled deterministically.
     - If a directory is the same as or an ancestor of the target, add it to a blocked list and continue.
     - Form the initial destination as `joinPath(target, baseName(source))`. When it already exists—including the source itself on same-parent duplication—find a free name by repeatedly incrementing the basename. For files only, preserve the last extension when its dot is after index zero. For directories, treat the entire basename as the stem. The sequence is `stem copy`, then `stem copy 2`, then `stem copy 3`; an existing `stem copy N` increments to `N+1`. If an existing numeric suffix is at or beyond `Number.MAX_SAFE_INTEGER`, append a new ` copy` segment rather than rounding it. Search at most 10,000 candidates and then fail that item with `Unable to find an available copy name for "<name>".`; never use a timestamp or overwrite.
     - Call `vscode.workspace.fs.copy(source, destination, { overwrite: false })`.
     - Catch stat, candidate-resolution, and copy errors per source; store `{ name, formattedReason }` and continue. Successful copies remain; no rollback occurs.
     - After progress, emit no success toast. Emit at most one warning for blocked self/descendant sources and at most one error for failed sources. Preserve the existing single-item warning text `Cannot copy "<name>" into itself.`. For multiple blocked/failed items, state the total, include at most the first three basenames/reasons, and append an `and N more` suffix to prevent long notification overflow.
     - Leave internal copy clipboard state intact after full success, partial success, or failure. Preserve the current clearing behavior for external clipboard use so the next paste re-reads the still-native clipboard.
   - Ordered control flow: normalized sources → progress starts → for each source: report → stat or record failure → self/descendant guard or continue → initial destination → if collision, deterministic directory-aware increment loop → non-overwriting recursive copy or record failure → progress ends → one bounded self-warning if needed → one bounded failure error if needed → existing external/internal clipboard cleanup.
     
     Empty normalized sources return before progress. A batch with all blocked or failed items changes no files. A partial batch retains successful destinations and retryable internal clipboard state.
   - Existing pattern/reference: `src/explorerCommands.ts` / view-scoped `withProgress` in `tabManager.explorer.refresh`; `formatOpenError`; current per-source paste loop; `exists`; `isSameOrAncestor`; existing simple ` copy` naming intent. `src/explorerProvider.ts` watcher-driven destination refresh remains the unchanged success-state mechanism.
   - Direct dependency impact: NONE. `workspace.fs.stat` and `workspace.fs.copy` are already used VS Code APIs; no dependency, schema, package, provider, or generated-source edit is required.
   - Test specification: In `src/test/suite/tabManager.e2e.test.ts`:
     - Paste a mixed batch of two files plus a dotted directory with nested content into a clean target; assert exact content, recursion, source preservation, and no source mutation.
     - Paste the retained batch twice more; assert `report copy.txt`/`report copy 2.txt`, `.env copy`/`.env copy 2`, and `folder.with.dot copy`/`folder.with.dot copy 2`, with every earlier destination unchanged.
     - Precreate a conflicting destination with sentinel content and assert it is never overwritten or merged.
     - Stub `withProgress` using the existing `withWindowStub` pattern; assert exact view location, pluralized count title, and a report for every normalized top-level source.
     - Copy a batch containing a valid source and a missing source; capture `showErrorMessage`, assert the valid item is copied, exactly one aggregate error mentions the missing basename, and no phantom missing destination exists. Then create the formerly missing source and paste again; assert it now copies and the valid source receives the next unique name, proving clipboard retention and recovery.
     - Retain the existing `prevents recursive folder paste from damaging user files` assertions for explicit self/descendant targets; extend only the copy portion if needed to prove another valid batch item still succeeds. Do not change the cut assertions.
   - Edge cases: Single and multiple sources; files, recursive folders, dotted folders, dotfiles, multi-extension files, already suffixed names, destination collisions created by earlier items in the same batch, source deleted after copy, permission/provider failure, exact self target, descendant target, all-failure batch, partial success, naming exhaustion, and a destination race after existence checking.
   - Done when: All valid top-level sources copy recursively and remain intact (AC-2/INV-3); every collision produces the exact safe naming sequence with `overwrite: false` (AC-4); self/descendant and per-item failures are isolated and summarized (AC-5/AC-6); native progress is present without custom UI (AC-7); and the move branch remains semantically unchanged (INV-1).
   - Validate: `npm run check-types` → zero TypeScript errors; then `npm run test:e2e` → all existing and new copy/paste, stale-source, recursive-safety, cut/move, watcher, and command-registration cases pass, proving AC-2 through AC-8 and INV-1 through INV-5.

3. **CP-3** — `src/test/suite/tabManager.e2e.test.ts` / dedicated Explorer copy/paste integration coverage and native-clipboard batch extension
   - Acceptance/invariant mapping: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, INV-1, INV-2, INV-3, INV-4, INV-5
   - Current behavior: Copy-related assertions are scattered across broad command and edge-case tests and primarily exercise one source. The native clipboard test conditionally verifies one external file. Existing helpers already expose `api.explorerView`, `itemFor`, `waitForExplorerNode`, `withWindowStub`, `withWarningMessage`, `withErrorMessage`, and `waitFor`.
   - Edit map: Add focused test cases near the existing Explorer clipboard tests; reuse existing helpers and add only a local capture fixture/helper if needed for message/progress assertions. Extend the existing conditional native clipboard test from one external file to a file-plus-folder batch rather than creating a separate platform process.
   - Change: Keep filesystem fixtures isolated under new unique workspace subdirectories. Use command invocation with the VS Code multi-select second argument for deterministic multi-context coverage, and use `TreeView.reveal(..., { select: true, focus: true })` for the real argument-less keyboard target case. For native interoperability, write/read both an external file and an external directory, skip only under the existing unsupported-headless condition, paste to an explicit target, and assert both contents. Do not weaken, delete, or broaden existing cut, drag/drop, stale-node, or recursive-protection assertions.
   - Ordered control flow: Create isolated fixtures → refresh provider → obtain live nodes where UI selection matters → execute copy → execute paste → await filesystem/tree state → assert destinations and untouched sources → repeat paste for names/recovery → cleanly restore any window stubs through existing `finally` behavior. Native test writes/reads the file-plus-folder set, skips only if the bridge cannot verify both, then performs and asserts the external batch paste.
   - Existing pattern/reference: Existing tests `covers explorer file commands, clipboard commands, compare, terminal, and drag-drop`, `handles likely Explorer edge cases from a user workflow`, `prevents recursive folder paste from damaging user files`, `pastes files placed on the OS clipboard by another application`, and `shows view-scoped progress while refreshing Explorer files`.
   - Direct dependency impact: NONE. TestApi already exposes `explorerView`; no `src/extension.ts` test hook change is authorized.
   - Test specification: Exact cases and assertions are those mapped in CP-1 and CP-2, plus:
     - Existing single copy, recursive copy, stale-source, OS freshness, and cut/move cases continue passing unchanged.
     - Context-menu-style multi-selection proves all selected top-level sources are captured.
     - Actual TreeView selection plus no-argument commands proves keyboard destination behavior.
     - Conditional native test proves a multi-source Finder/File Explorer batch where the platform bridge is available.
   - Edge cases: Test order must not rely on stale Explorer selection. Place the real-selection test after no-argument tests that assume an empty selection, or explicitly reveal a neutral node afterward; all other new paste tests must pass explicit destination nodes.
   - Done when: Every AC has an automated command-path assertion where the VS Code test host can support it, existing preservation tests remain unchanged and green, and native clipboard capability is clearly reported as pass or skip rather than assumed.
   - Validate: `npm run test:e2e` → zero failures; output must identify the native clipboard test as passed or explicitly skipped. Any skip requires the manual macOS Finder check in `VALIDATION_PLAN` and final Sol review before completion.

### ALLOWED_EXECUTOR_DISCRETION
- Private helper names may differ from the descriptive names above if their responsibility, call site, and behavior are identical.
- Local variable names, import ordering, formatting, and exact isolated fixture directory/file contents are discretionary.
- The first-three-items aggregate-message formatter may use commas or semicolons, but must preserve the specified count, basenames/reasons, bounded length, single-notification rule, and `and N more` meaning.
- Nonsemantic test-stub shape may follow the existing `withWindowStub` conventions.
- Terra may mechanically repair only its own immediately introduced syntax, type, import, or formatting errors using an identical local repository pattern.
- No semantic branch, filename rule, target rule, collision policy, failure policy, progress location, changed file, or additional validation is discretionary.

### MANDATORY_ESCALATION
- Stop before editing any file other than `src/explorerCommands.ts` or `src/test/suite/tabManager.e2e.test.ts`.
- Stop if implementation appears to require `src/osClipboard.ts`, `src/explorerProvider.ts`, `src/extension.ts`, `package.json`, a dependency, a new module, a generated artifact, or a public/test API change.
- Stop if the VS Code test host does not pass the multi-selection array as documented, cannot programmatically exercise the real selected-folder path through the existing `explorerView`, or `workspace.fs.copy(..., { overwrite: false })` does not recursively copy directories on the supported test host.
- Stop if preserving Cut/Move exactly conflicts with the copy-only branch separation, or if any existing cut, drag/drop, rename, delete, watcher, filter, or OS-freshness test changes behavior.
- Stop if collision correctness would require replace, merge, delete-before-copy, overwrite, transaction/rollback, undo, custom recursion, concurrency, or a user-facing choice not specified in this plan.
- Stop if a failing test has an uncertain cause, the same step fails twice, a test would need weakening/removal, or native/manual validation cannot prove AC-8.
- USER_DECISION_REQUIRED before broadening SCOPE_LOCK for any reason. The executor must not act on OUT_OF_SCOPE_FINDINGS or add cleanup, refactors, UX redesign, move/cut improvements, documentation, configuration, dependencies, or unrelated tests.

### VALIDATION_PLAN
- Compile/type check: `npm run check-types` → exits 0 with no TypeScript diagnostics.
- Build: `npm run compile` → exits 0 and produces the extension bundle without new warnings; do not treat this as functional or visual verification.
- Unit: N/A — the repository has no separate unit-test script; private copy helpers are exercised through the registered command paths in the Extension Host E2E suite.
- Integration: `npm run test:e2e` → exits 0; new multi-file/folder, nested-selection, keyboard folder duplication, repeated naming, no-overwrite, progress, partial-failure/retry, recursive safety, and native batch cases pass; all existing cut/move and unrelated cases remain green.
- Lint/static analysis: No lint script/configuration exists. Run `npm run check-types` plus `git diff --check`; both must pass.
- Diff/scope review: `git diff -- src/explorerCommands.ts src/test/suite/tabManager.e2e.test.ts` → every hunk maps to AC-1–AC-8 or INV-1–INV-5; `git status --short` shows no executor-created product/test changes outside the two authorized files and no debug output, TODO, bypass, or temporary workaround.
- Manual functional business scenario: In a VS Code Extension Development Host on macOS, open a disposable fixture workspace. In Extended Explorer, Cmd-click at least two files and one recursive folder, press Cmd+C, select a different folder and press Cmd+V; verify all items and nested content appear and sources remain. Paste again and verify exact `copy`/`copy 2` names. Select a source folder, press Cmd+C then Cmd+V without changing selection, and verify a sibling folder is created with no `source/source` nesting. Context-menu Paste on a different explicit folder must still paste inside it.
- Manual Finder interoperability: Copy a file-plus-folder selection in Finder and paste it into an Extended Explorer destination; then copy the same kind of multi-selection in Extended Explorer and paste it into a disposable Finder folder. Verify all top-level sources and recursive contents in both directions. If the conditional E2E native test skipped, this manual check is mandatory and its result must be reported.
- Manual visual QA, separate from function: Inspect the native Extended Explorer during a multi-item paste at narrow, normal, and wide sidebar widths in the desktop Extension Development Host. Verify the view-scoped progress title/count is visible without occluding tree controls, long names are handled by native truncation, selection/focus remains usable, copied items retain native icons/styles, success is quiet, and a forced stale-source batch produces only one bounded native error. Mobile/tablet browser viewports are not applicable because this is a native VS Code TreeView, not a web route.
- Performance/data/authorization: Use a disposable batch with at least 25 small top-level items plus one nested directory; verify deterministic sequential completion, responsive native progress updates, no existing sentinel destination changes, no source changes, and no rename/delete calls from the copy path. No auth boundary is involved.
- Review gate: If any required validation is skipped, the native clipboard test cannot run, manual Finder/visual QA is unavailable, or the plan is amended, require read-only final Sol review with the full plan, diff, and command/manual evidence.

### ROLLBACK_OR_RECOVERY
N/A for NORMAL risk. Copy is deliberately non-destructive and per-item best-effort; if validation fails, stop, retain any disposable test copies for diagnosis, and revert only the executor’s mapped hunks through the workflow rather than deleting or resetting user data.

### OPEN_ASSUMPTIONS
- Verified: Extended Explorer enables `canSelectMany`; VS Code passes all selected tree items as the second command argument; the current command handler and native clipboard writer already accept arrays.
- Verified: The supported VS Code 1.85 API includes recursive `workspace.fs.copy`, `workspace.fs.stat`, view-scoped progress, and TreeView selection/reveal APIs used by this plan.
- Verified: Existing product behavior and tests choose non-destructive “keep both” copy naming rather than replace/merge, so Finder-level behavior inside SCOPE_LOCK is deterministically defined by AC-1–AC-8. Destructive replace/merge/undo behavior is not an unresolved assumption and remains a non-goal.
- Verified: No repository-specific design system or web surface applies; native VS Code TreeView, progress, warning, and error components are the established visual language.
- Remaining blocker: NONE.

### PLAN_COMPLETENESS_SELF_CHECK
- Remaining meaningful executor decisions inside SCOPE_LOCK: NONE
- Planned changes or tests without an AC-*/INV-* mapping: NONE
- Unspecified direct-caller, error, edge-case, or test behavior inside SCOPE_LOCK: NONE
- OUT_OF_SCOPE_FINDINGS converted into work: ZERO
- Unauthorized scope expansion: ZERO
- Evidence that each acceptance criterion maps to implementation and validation: AC-1 → CP-1 plus multi-selection/nested-source E2E; AC-2 → CP-2 plus mixed recursive batch E2E; AC-3 → CP-1 plus real TreeView-selected folder keyboard E2E/manual flow; AC-4 → CP-2 plus repeated file/dotfile/dotted-folder and sentinel no-overwrite E2E; AC-5 → CP-2 plus existing self/descendant safety and partial-batch E2E; AC-6 → CP-2 plus missing-source aggregate/retry E2E; AC-7 → CP-2 plus captured progress E2E and native visual QA; AC-8 → CP-1/CP-3 plus conditional native multi-source E2E and mandatory Finder round-trip manual check; INV-1–INV-5 → copy-only branch boundary, unchanged direct dependencies, complete existing E2E suite, diff/scope review, and manual Extension Development Host verification.
