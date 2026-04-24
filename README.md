# Tab Manager

A VS Code extension that brings grouping, filtering, and sorting to open tabs — and adds a second, filter-aware file tree in the Explorer sidebar.

## Highlights

- **Tab view** in the activity bar with user-defined groups, multi-select close, and sort
- **Extended Explorer** in the Explorer sidebar with inline New File / New Folder, a live file-system watcher, and a deleted-file ghost view
- **Shared filter state**: one click toggles Modified / Untracked / Deleted / Errors / Open-Tabs-Only across both views
- **Shared sort state**: by name (asc/desc) × by file extension, combinable
- Performance: URI caches, WeakMap memoization, and debounced events keep the tree responsive during `git checkout`, mass saves, and rapid filter toggles

## Features

### Tab view (activity bar)

- Lists every open tab across all editor groups (split views)
- **Groups** — create named groups, drop tabs into them via `Add to Group...`, rename/delete freely. Tabs not in any group live under an `Ungrouped` section. With no groups defined, tabs are shown as a flat list
- **Multi-select** — Ctrl/Cmd + click or Shift + click, then `Close Selected Tabs`
- **Open behavior** — clicking a tab reveals it in its original editor column; preview (italic) state is preserved
- **Tab kinds supported** — text, text diff, notebook, notebook diff, custom editor, terminal (webview tabs cannot be refocused via public VS Code API)

### Extended Explorer (Explorer sidebar)

- **View title** shows the workspace name (or the `.code-workspace` filename for multi-root)
- **Tree root** — a single-folder workspace shows its contents directly (like built-in Explorer); a multi-root workspace shows each folder as a root node
- **Inline New File / New Folder** — a placeholder item appears inside the target folder and updates live as you type in the input box
- **Deleted files** appear as ghost entries (greyed out, `deleted` label) when the Deleted filter is on
- **Refresh** forces a `git status` rescan on every repository before refreshing
- **Context menu**: Open / Open to Side / Reveal in File Explorer / Open in Integrated Terminal / Copy Path / Copy Relative Path / Rename / Delete / New File / New Folder
- **Title bar**: New File, New Folder, Refresh, filter buttons, sort options

### Filters

| Filter       | Source                                              |
| ------------ | --------------------------------------------------- |
| Modified     | Git working tree `MODIFIED`                         |
| Untracked    | Git working tree `UNTRACKED`                        |
| Deleted      | Git working tree `DELETED`                          |
| Errors       | `DiagnosticSeverity.Error` from language servers    |
| Open Tabs Only | URIs currently open as tabs                       |

- Only one filter is active at a time; clicking the active filter turns it off
- Active filter is shown in each view's description (`Filter: Modified`)
- `Modified` and `Errors` are inline title-bar buttons; other filters live in the overflow `...` menu

### Sort

- **By name**: Ascending / Descending / Off (radio)
- **By type** (file extension): on/off toggle
- Both can be on together — tabs/files group by extension first, then by name
- Directories always come first in the Explorer (like built-in)

## Installation

### From a `.vsix` file

```bash
code --install-extension tab-manager-0.1.0.vsix
```

Or, in VS Code: `Extensions` panel → `...` menu → `Install from VSIX...`.

### Requirements

- VS Code `1.85.0` or higher
- The built-in `vscode.git` extension (bundled with VS Code) is required for git-based filters. Without git, the `Errors` and `Open Tabs Only` filters still work.

## Commands

All commands are discoverable in the Command Palette under `Tab Manager:` / `Extended Explorer:` prefixes.

**Groups** — `New Group`, `Rename Group`, `Delete Group`, `Add to Group...`, `Remove from Group`

**Tabs** — `Close Tab`, `Close Selected Tabs`, `Open Tab`

**Filters** — `Show Modified Only`, `Show Untracked Only`, `Show Deleted Only`, `Show Errors Only`, `Show Open Tabs Only`, `Clear Filter`

**Sort** — `Sort by Name (Ascending)`, `Sort by Name (Descending)`, `No Name Sort`, `Sort by Type`

**Explorer** — `New File...`, `New Folder...`, `Refresh Explorer`, `Rename...`, `Delete`, `Copy Path`, `Copy Relative Path`, `Reveal in File Explorer`, `Open in Integrated Terminal`, `Open to the Side`

## Known limitations

- VS Code does not expose an API for inline editing in tree views. New File / New Folder uses a top-positioned input box synced live with a placeholder item in the tree — the closest approximation to the built-in Explorer's inline input
- The built-in Explorer cannot be replaced or removed programmatically. The Extended Explorer is contributed alongside it with `"order": 0` so it tends to appear first; if it does not, drag the section header above the built-in Explorer once and VS Code remembers the order
- The `Errors` filter reflects only diagnostics that language servers have already produced — refreshing cannot force language servers to scan unopened files
- Webview tabs without an associated URI cannot be programmatically refocused
- Drag-and-drop between groups or folders is not implemented
- Cut / Copy / Paste of files is not implemented (use built-in Explorer for that)

## Development

```bash
npm install
npm run compile    # typecheck + bundle with esbuild
npm run watch      # incremental rebuild on save
```

Press **F5** to launch an Extension Development Host with the extension loaded.

### Project layout

```
src/
  extension.ts          # activation, command wiring, context-key sync
  groupStore.ts         # persisted state: groups, sort, filter
  filterSource.ts       # git + diagnostics + open-tab URI source (Set cache + 50ms debounce)
  explorerProvider.ts   # hierarchical workspace tree with filter, pending-item, and dir cache
  explorerCommands.ts   # new/rename/delete/reveal/etc., inline-create UX
  tabProvider.ts        # open-tabs tree, groups, sort (debounced refresh)
  tabUtils.ts           # tab key/category/uri helpers (WeakMap-cached)
  util.ts               # debounce helper
media/
  icon.png              # 128×128 marketplace icon (transparent background)
  icon.svg              # source for icon.png
  tab-icon.svg          # monochrome activity-bar icon
```

### Performance notes

- **FilterSource** caches `Set<string>` per filter mode — `matches()` is O(1) instead of linear scan over git changes
- **ExplorerProvider** caches `readDirectory` results per folder; filter/sort changes reuse the cache, only file-system events invalidate entries
- **WeakMap caches** in `tabUtils` memoize `resourceUriFor` / `tabKey` / `tabTypeKey` / `tabTypeCategory` per `vscode.Tab` instance
- Events from git / diagnostics / fs / tabs are debounced (30–80 ms) so rapid bursts (e.g., `git checkout`, `npm install`) collapse into a single refresh

## Packaging & publishing

Install the extension packager:

```bash
npm install -g @vscode/vsce
```

Then update `package.json`:

1. `publisher` → your marketplace publisher ID (create one at <https://marketplace.visualstudio.com/manage>)
2. `repository` → add your git repository URL, for example:
   ```json
   "repository": { "type": "git", "url": "https://github.com/you/tab-manager.git" }
   ```
3. Bump `version` for every publish

Package / publish:

```bash
vsce package           # produces tab-manager-<version>.vsix
vsce login <publisher>
vsce publish
```

### What ends up in the `.vsix`

Controlled by `.vscodeignore`. The packaged archive only contains:

- `dist/extension.js` — the bundled extension
- `media/icon.png`, `media/tab-icon.svg`
- `package.json`, `README.md`, `LICENSE`

Source files, node_modules, source maps, and local dev artifacts (`.vscode/`, `.claude/`, `.lh/`, `.zoek*`) are excluded.

## Changelog

See `CHANGELOG.md` in the extension package.

## License

MIT. See `LICENSE`.
