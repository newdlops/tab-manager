import * as vscode from 'vscode';
import { GroupStore, type FilterMode } from './groupStore';
import { openTab } from './tabUtils';
import { GroupNode, TabNode, TabTreeDataProvider } from './tabProvider';
import { FilterSource } from './filterSource';
import { ExplorerProvider } from './explorerProvider';
import { registerExplorerCommands } from './explorerCommands';
import { debounce } from './util';

export function activate(context: vscode.ExtensionContext) {
  const store = new GroupStore(context);
  const filterSource = new FilterSource();
  const provider = new TabTreeDataProvider(store, filterSource);
  const explorerProvider = new ExplorerProvider(store, filterSource);

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

  const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const scheduleExplorerRefresh = debounce(() => explorerProvider.refresh(), 80);
  const onFsEvent = (uri: vscode.Uri) => {
    explorerProvider.invalidateDirectory(
      uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/') || 1) }),
    );
    scheduleExplorerRefresh();
  };
  fsWatcher.onDidCreate(onFsEvent);
  fsWatcher.onDidDelete(onFsEvent);
  fsWatcher.onDidChange(onFsEvent);

  registerExplorerCommands(context, explorerProvider, filesView, filterSource);

  const selectedTabNodes = (fallback?: TabNode): TabNode[] => {
    const sel = view.selection.filter((n): n is TabNode => n instanceof TabNode);
    if (sel.length > 0) return sel;
    return fallback ? [fallback] : [];
  };

  const syncSortContext = () => {
    const s = store.getSortState();
    vscode.commands.executeCommand('setContext', 'tabManager.sortName', s.name);
    vscode.commands.executeCommand('setContext', 'tabManager.sortType', s.type);
  };
  const syncFilterState = () => {
    const mode = store.getFilterMode();
    vscode.commands.executeCommand('setContext', 'tabManager.filterMode', mode);
    const desc = mode === 'none' ? undefined : `Filter: ${capitalize(mode)}`;
    view.description = desc;
    filesView.description = desc;
  };
  const syncExplorerTitle = () => {
    filesView.title = vscode.workspace.name ?? 'Workspace';
  };
  syncExplorerTitle();
  syncSortContext();
  syncFilterState();
  store.onDidChange(() => {
    syncSortContext();
    syncFilterState();
  });

  context.subscriptions.push(
    view,
    filesView,
    filterSource,
    fsWatcher,
    vscode.window.tabGroups.onDidChangeTabs(() => scheduleTabRefresh()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => scheduleTabRefresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncExplorerTitle();
      explorerProvider.refresh();
    }),

    vscode.commands.registerCommand('tabManager.openTab', (node: TabNode) => openTab(node.tab)),

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

      for (const t of targets) {
        await store.addTabToGroup(groupId, t.key);
      }
    }),

    vscode.commands.registerCommand('tabManager.removeFromGroup', async (node: TabNode) => {
      const targets = selectedTabNodes(node);
      for (const t of targets) {
        await store.removeTabFromGroup(t.key);
      }
    }),

    vscode.commands.registerCommand('tabManager.sort.nameAsc', () => store.setNameSort('asc')),
    vscode.commands.registerCommand('tabManager.sort.nameDesc', () => store.setNameSort('desc')),
    vscode.commands.registerCommand('tabManager.sort.nameNone', () => store.setNameSort('none')),
    vscode.commands.registerCommand('tabManager.sort.toggleType', () => store.toggleTypeSort()),

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
    vscode.commands.registerCommand('tabManager.filter.clear', () => store.setFilterMode('none')),
  );
}

function capitalize(s: FilterMode): string {
  switch (s) {
    case 'tabsOnly':
      return 'Tabs Only';
    default:
      return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

export function deactivate(): void {}
