import * as vscode from 'vscode';
import { GroupStore, type FilterMode, type SortState, type TabLayoutMode } from './groupStore';
import { openTab, resourceUriFor } from './tabUtils';
import { GroupNode, TabNode, TabTreeDataProvider } from './tabProvider';
import { FilterSource } from './filterSource';
import { ExplorerProvider } from './explorerProvider';
import { registerExplorerCommands } from './explorerCommands';
import { UnsavedDecorationProvider } from './unsavedDecorations';
import { debounce } from './util';

export function activate(context: vscode.ExtensionContext) {
  const store = new GroupStore(context);
  const filterSource = new FilterSource();
  const provider = new TabTreeDataProvider(store, filterSource);
  const explorerProvider = new ExplorerProvider(store, filterSource);
  const unsavedDecorations = new UnsavedDecorationProvider(filterSource);

  const view = vscode.window.createTreeView('tabManagerView', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
  });
  const filesView = vscode.window.createTreeView('tabManagerExplorer', {
    treeDataProvider: explorerProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: explorerProvider,
  });

  const scheduleTabRefresh = debounce(() => provider.refresh(), 30);

  // Watch only structural changes (create/delete). File-content changes do
  // not affect the tree and would otherwise flood the extension during
  // builds, npm installs, or watch tasks.
  const fsWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*',
    /* ignoreCreateEvents */ false,
    /* ignoreChangeEvents */ true,
    /* ignoreDeleteEvents */ false,
  );
  const pendingDirInvalidations = new Set<string>();
  const flushExplorerRefresh = debounce(() => {
    if (pendingDirInvalidations.size > 0) {
      for (const dir of pendingDirInvalidations) {
        explorerProvider.invalidateDirectory(vscode.Uri.parse(dir));
      }
      pendingDirInvalidations.clear();
    }
    explorerProvider.requestRedraw();
  }, 80);
  const onFsEvent = (uri: vscode.Uri) => {
    const slash = uri.path.lastIndexOf('/');
    const parent = uri.with({ path: slash > 0 ? uri.path.slice(0, slash) : '/' });
    pendingDirInvalidations.add(parent.toString());
    filterSource.notifyFileSystemChange(uri);
    flushExplorerRefresh();
  };
  fsWatcher.onDidCreate(onFsEvent);
  fsWatcher.onDidDelete(onFsEvent);

  registerExplorerCommands(context, explorerProvider, filesView, filterSource);

  const selectedTabNodes = (fallback?: TabNode): TabNode[] => {
    const sel = view.selection.filter((n): n is TabNode => n instanceof TabNode);
    if (sel.length > 0) return sel;
    return fallback ? [fallback] : [];
  };

  let lastSortContext: SortState | undefined;
  let lastFilterContext: FilterMode | undefined;
  let lastLayoutContext: TabLayoutMode | undefined;
  const updateViewDescriptions = () => {
    const mode = store.getFilterMode();
    const layout = store.getTabLayoutMode();
    const filterDesc = mode === 'none' ? undefined : `Filter: ${capitalize(mode)}`;
    filesView.description = filterDesc;
    view.description = [layout === 'byColumn' ? 'By Column' : undefined, filterDesc]
      .filter((part): part is string => !!part)
      .join(' · ') || undefined;
  };
  const syncSortContext = () => {
    const s = store.getSortState();
    if (
      lastSortContext &&
      lastSortContext.name === s.name &&
      lastSortContext.type === s.type &&
      lastSortContext.readOnly === s.readOnly
    ) {
      return;
    }
    lastSortContext = s;
    vscode.commands.executeCommand('setContext', 'tabManager.sortName', s.name);
    vscode.commands.executeCommand('setContext', 'tabManager.sortType', s.type);
    vscode.commands.executeCommand('setContext', 'tabManager.sortReadOnly', s.readOnly);
  };
  const syncFilterState = () => {
    const mode = store.getFilterMode();
    if (lastFilterContext !== mode) {
      lastFilterContext = mode;
      vscode.commands.executeCommand('setContext', 'tabManager.filterMode', mode);
    }
    updateViewDescriptions();
  };
  const syncLayoutState = () => {
    const mode = store.getTabLayoutMode();
    if (lastLayoutContext !== mode) {
      lastLayoutContext = mode;
      vscode.commands.executeCommand('setContext', 'tabManager.tabLayout', mode);
    }
    updateViewDescriptions();
  };
  const syncExplorerTitle = () => {
    filesView.title = vscode.workspace.name ?? 'Workspace';
  };
  syncExplorerTitle();
  syncSortContext();
  syncFilterState();
  syncLayoutState();
  store.onDidChange(() => {
    syncSortContext();
    syncFilterState();
    syncLayoutState();
  });

  context.subscriptions.push(
    view,
    filesView,
    filterSource,
    unsavedDecorations,
    vscode.window.registerFileDecorationProvider(unsavedDecorations),
    fsWatcher,
    vscode.window.tabGroups.onDidChangeTabs(() => scheduleTabRefresh()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => scheduleTabRefresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncExplorerTitle();
      explorerProvider.refresh();
    }),

    vscode.commands.registerCommand('tabManager.openTab', (node: TabNode) => openTab(node.tab)),

    vscode.commands.registerCommand('tabManager.explorer.revealActive', async () => {
      const uri = activeResourceUri();
      if (!uri) {
        vscode.window.showInformationMessage('No active file to reveal.');
        return;
      }
      const node = explorerProvider.nodeForUri(uri);
      if (!node) {
        vscode.window.showWarningMessage('Active file is not inside an open workspace folder.');
        return;
      }
      try {
        await filesView.reveal(node, { select: true, focus: true, expand: true });
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to reveal: ${String(e)}`);
      }
    }),

    vscode.commands.registerCommand('tabManager.closeTab', async (node: TabNode) => {
      const targets = selectedTabNodes(node);
      await vscode.window.tabGroups.close(
        targets.map((n) => n.tab),
        true,
      );
    }),

    vscode.commands.registerCommand('tabManager.closeSelected', async () => {
      const targets = selectedTabNodes();
      if (targets.length === 0) return;
      await vscode.window.tabGroups.close(
        targets.map((n) => n.tab),
        true,
      );
    }),

    vscode.commands.registerCommand('tabManager.createGroup', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Group name' });
      const trimmed = name?.trim();
      if (!trimmed) return;
      await store.createGroup(trimmed);
    }),

    vscode.commands.registerCommand('tabManager.renameGroup', async (node: GroupNode) => {
      const name = await vscode.window.showInputBox({
        prompt: 'Rename group',
        value: node.group.name,
      });
      const trimmed = name?.trim();
      if (!trimmed || trimmed === node.group.name) return;
      await store.renameGroup(node.group.id, trimmed);
    }),

    vscode.commands.registerCommand('tabManager.deleteGroup', async (node: GroupNode) => {
      const pick = await vscode.window.showWarningMessage(
        `Delete group "${node.group.name}"? Tabs move to Ungrouped.`,
        { modal: true },
        'Delete',
      );
      if (pick !== 'Delete') return;
      await store.deleteGroup(node.group.id);
    }),

    vscode.commands.registerCommand('tabManager.addToGroup', async (node: TabNode) => {
      const targets = selectedTabNodes(node);
      if (targets.length === 0) return;

      const existing = store.getGroups();
      type Pick = vscode.QuickPickItem & { id?: string; create?: boolean };
      const items: Pick[] = [
        ...existing.map((g) => ({ label: g.name, id: g.id })),
        { label: '$(add) New group...', create: true },
      ];
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Add ${targets.length} tab${targets.length === 1 ? '' : 's'} to group`,
      });
      if (!choice) return;

      let groupId = choice.id;
      if (choice.create) {
        const name = await vscode.window.showInputBox({ prompt: 'Group name' });
        const trimmed = name?.trim();
        if (!trimmed) return;
        groupId = (await store.createGroup(trimmed)).id;
      }
      if (!groupId) return;

      await store.addTabsToGroup(
        groupId,
        targets.map((t) => t.key),
      );
    }),

    vscode.commands.registerCommand('tabManager.removeFromGroup', async (node: TabNode) => {
      const targets = selectedTabNodes(node);
      await store.removeTabsFromGroups(targets.map((t) => t.key));
    }),

    vscode.commands.registerCommand('tabManager.sort.nameAsc', () => store.setNameSort('asc')),
    vscode.commands.registerCommand('tabManager.sort.nameDesc', () => store.setNameSort('desc')),
    vscode.commands.registerCommand('tabManager.sort.nameNone', () => store.setNameSort('none')),
    vscode.commands.registerCommand('tabManager.sort.toggleType', () => store.toggleTypeSort()),
    vscode.commands.registerCommand('tabManager.sort.toggleReadOnly', () =>
      store.toggleReadOnlySort(),
    ),
    vscode.commands.registerCommand('tabManager.layout.byColumn', () =>
      store.setTabLayoutMode('byColumn'),
    ),
    vscode.commands.registerCommand('tabManager.layout.merged', () =>
      store.setTabLayoutMode('merged'),
    ),

    vscode.commands.registerCommand('tabManager.filter.modified', () =>
      store.toggleFilterMode('modified'),
    ),
    vscode.commands.registerCommand('tabManager.filter.untracked', () =>
      store.toggleFilterMode('untracked'),
    ),
    vscode.commands.registerCommand('tabManager.filter.deleted', () =>
      store.toggleFilterMode('deleted'),
    ),
    vscode.commands.registerCommand('tabManager.filter.errors', () =>
      store.toggleFilterMode('errors'),
    ),
    vscode.commands.registerCommand('tabManager.filter.tabsOnly', () =>
      store.toggleFilterMode('tabsOnly'),
    ),
    vscode.commands.registerCommand('tabManager.filter.unsaved', () =>
      store.toggleFilterMode('unsaved'),
    ),
    vscode.commands.registerCommand('tabManager.filter.readOnly', () =>
      store.toggleFilterMode('readOnly'),
    ),
    vscode.commands.registerCommand('tabManager.filter.clear', () => store.setFilterMode('none')),
  );
}

function capitalize(s: FilterMode): string {
  switch (s) {
    case 'tabsOnly':
      return 'Tabs Only';
    case 'unsaved':
      return 'Unsaved';
    case 'readOnly':
      return 'Read-only';
    default:
      return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

function activeResourceUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab) {
    const uri = resourceUriFor(tab);
    if (uri) return uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

export function deactivate(): void {}
