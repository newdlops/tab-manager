import * as vscode from 'vscode';
import {
  GroupStore,
  type ExplorerDisplayOptions,
  type FilterMode,
  type SortState,
  type TabLayoutMode,
} from './groupStore';
import { findLiveTab, openTab, resourceUriFor } from './tabUtils';
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
  const scheduleTabRefreshForTabs = (event: vscode.TabChangeEvent) => {
    if (event.opened.length > 0 || event.closed.length > 0) scheduleTabRefresh();
  };
  const scheduleTabRefreshForGroups = (event: vscode.TabGroupChangeEvent) => {
    if (event.opened.length > 0 || event.closed.length > 0) scheduleTabRefresh();
  };

  registerExplorerCommands(context, explorerProvider, filesView, filterSource);

  const selectedTabNodes = (fallback?: TabNode): TabNode[] => {
    const sel = view.selection.filter((n): n is TabNode => n instanceof TabNode);
    if (sel.length > 0) return sel;
    return fallback ? [fallback] : [];
  };
  const liveTabsForNodes = (nodes: readonly TabNode[]): vscode.Tab[] => {
    const tabs: vscode.Tab[] = [];
    const seen = new Set<vscode.Tab>();
    for (const node of nodes) {
      const tab = findLiveTab(node.tab);
      if (!tab) continue;
      if (seen.has(tab)) continue;
      seen.add(tab);
      tabs.push(tab);
    }
    return tabs;
  };
  const closeTabNodes = async (nodes: readonly TabNode[]) => {
    const tabs = liveTabsForNodes(nodes);
    if (tabs.length === 0) {
      provider.refresh();
      return;
    }
    try {
      await vscode.window.tabGroups.close(tabs, true);
    } catch (e) {
      provider.refresh();
      vscode.window.showErrorMessage(`Failed to close tab${tabs.length === 1 ? '' : 's'}: ${String(e)}`);
    }
  };

  let lastSortContext: SortState | undefined;
  let lastFilterContext: FilterMode | undefined;
  let lastLayoutContext: TabLayoutMode | undefined;
  let lastExplorerDisplayContext: ExplorerDisplayOptions | undefined;
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
  const syncExplorerDisplayState = () => {
    const options = store.getExplorerDisplayOptions();
    if (
      lastExplorerDisplayContext &&
      lastExplorerDisplayContext.fileSize === options.fileSize &&
      lastExplorerDisplayContext.lineCount === options.lineCount
    ) {
      return;
    }
    lastExplorerDisplayContext = options;
    vscode.commands.executeCommand(
      'setContext',
      'tabManager.explorerShowFileSize',
      options.fileSize,
    );
    vscode.commands.executeCommand(
      'setContext',
      'tabManager.explorerShowLineCount',
      options.lineCount,
    );
  };
  const syncExplorerTitle = () => {
    filesView.title = vscode.workspace.name ?? 'Workspace';
  };
  syncExplorerTitle();
  syncSortContext();
  syncFilterState();
  syncLayoutState();
  syncExplorerDisplayState();
  store.onDidChange(() => {
    syncSortContext();
    syncFilterState();
    syncLayoutState();
    syncExplorerDisplayState();
  });

  context.subscriptions.push(
    view,
    filesView,
    explorerProvider,
    filterSource,
    unsavedDecorations,
    vscode.window.registerFileDecorationProvider(unsavedDecorations),
    vscode.window.tabGroups.onDidChangeTabs(scheduleTabRefreshForTabs),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleTabRefreshForGroups),
    filesView.onDidCollapseElement((event) => explorerProvider.unwatchNode(event.element)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncExplorerTitle();
      explorerProvider.refresh();
    }),

    vscode.commands.registerCommand('tabManager.openTab', (node?: TabNode) => {
      if (!node) return;
      return openTab(node.tab);
    }),

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
      await closeTabNodes(targets);
    }),

    vscode.commands.registerCommand('tabManager.closeSelected', async () => {
      const targets = selectedTabNodes();
      if (targets.length === 0) return;
      await closeTabNodes(targets);
    }),

    vscode.commands.registerCommand('tabManager.createGroup', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Group name' });
      const trimmed = name?.trim();
      if (!trimmed) return;
      await store.createGroup(trimmed);
    }),

    vscode.commands.registerCommand('tabManager.renameGroup', async (node?: GroupNode) => {
      if (!node) return;
      const name = await vscode.window.showInputBox({
        prompt: 'Rename group',
        value: node.group.name,
      });
      const trimmed = name?.trim();
      if (!trimmed || trimmed === node.group.name) return;
      await store.renameGroup(node.group.id, trimmed);
    }),

    vscode.commands.registerCommand('tabManager.deleteGroup', async (node?: GroupNode) => {
      if (!node) return;
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
    vscode.commands.registerCommand('tabManager.explorer.toggleFileSize', () =>
      store.toggleExplorerFileSize(),
    ),
    vscode.commands.registerCommand('tabManager.explorer.toggleLineCount', () =>
      store.toggleExplorerLineCount(),
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

  if (process.env.TAB_MANAGER_E2E === '1') {
    return {
      store,
      tabProvider: provider,
      explorerProvider,
      filterSource,
      context,
      tabView: view,
      explorerView: filesView,
    };
  }
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
