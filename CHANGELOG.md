# Changelog

All notable changes are documented here.

## [0.1.0]

Initial public release.

### Tab view
- Activity-bar view listing every open tab
- User-defined named groups with add / remove / rename / delete
- `Ungrouped` section for tabs not assigned to a group
- Flat display when no groups are defined
- Multi-select and `Close Selected Tabs`
- Click-to-focus for text, text diff, notebook, notebook diff, custom editor, and terminal tabs
- Preview (italic) state preserved on open

### Extended Explorer (Explorer sidebar)
- Hierarchical workspace file tree
- View title follows `vscode.workspace.name`
- Single-folder workspaces show contents at the tree root; multi-root workspaces show one node per folder
- Inline-feeling `New File...` / `New Folder...` with a placeholder item that updates live
- Ghost entries for git-deleted files when the Deleted filter is active
- Context menu: Open / Open to Side / Reveal in File Explorer / Open in Integrated Terminal / Copy Path / Copy Relative Path / Rename / Delete / New File / New Folder
- Refresh forces a `git status` rescan before refreshing the tree

### Filters (shared between views)
- Modified / Untracked / Deleted (git working tree), Errors (`DiagnosticSeverity.Error`), Open Tabs Only
- Modified and Errors as inline title-bar buttons; others in the overflow menu with ✓ check indicator
- Active filter shown in each view's description

### Sort (shared between views)
- Sort by name: Ascending / Descending / Off
- Sort by type (file extension) as an independent toggle
- Both can be combined — groups files by extension, then by name within

### Performance
- `Set<string>` cache per filter mode in `FilterSource` — O(1) `matches()`
- `readDirectory` cache per folder URI; invalidated only on file-system events
- `WeakMap` caches for tab utilities keyed by `vscode.Tab` instance
- 30–80 ms debounce on tree refreshes to collapse bursts from git / fs / diagnostics
