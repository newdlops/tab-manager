import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GroupStore } from '../../groupStore';
import { comparisonEntriesFromSnapshot } from '../../comparisonSource';
import { ExplorerErrorNode } from '../../explorerProvider';
import { ProjectNode } from '../../projectProvider';

type FilterMode =
  | 'none'
  | 'modified'
  | 'untracked'
  | 'deleted'
  | 'errors'
  | 'tabsOnly'
  | 'unsaved'
  | 'readOnly'
  | 'prComments'
  | 'prFiles'
  | 'comparison';

interface UserGroup {
  id: string;
  name: string;
  tabKeys: string[];
}

interface SortState {
  name: 'none' | 'asc' | 'desc';
  type: boolean;
  readOnly: boolean;
}

interface ExplorerDisplayOptions {
  fileSize: boolean;
  lineCount: boolean;
}

interface TestApi {
  context: vscode.ExtensionContext;
  store: {
    getGroups(): UserGroup[];
    deleteGroup(id: string): Promise<void>;
    getSortState(): SortState;
    getFilterMode(): FilterMode;
    getTabLayoutMode(): 'byColumn' | 'merged';
    getExplorerDisplayOptions(): ExplorerDisplayOptions;
  };
  tabProvider: {
    readonly onDidChangeTreeData: vscode.Event<unknown | undefined>;
    refresh(): void;
    getChildren(element?: unknown): unknown[] | Thenable<unknown[]>;
  };
  explorerProvider: {
    readonly onDidChangeTreeData: vscode.Event<unknown | undefined>;
    refresh(): void;
    getChildren(element?: unknown): unknown[] | Thenable<unknown[]>;
    handleDrag(source: readonly unknown[], dataTransfer: vscode.DataTransfer): void;
    handleDrop(target: unknown, dataTransfer: vscode.DataTransfer): Promise<void>;
  };
  filterSource: {
    refresh(): Promise<void>;
    getUris(mode: FilterMode): vscode.Uri[];
    getEntries(mode: FilterMode): Array<{ uri: vscode.Uri; status?: string }>;
    matches(uri: vscode.Uri, mode: FilterMode): boolean;
    isReadOnly(uri: vscode.Uri): boolean;
    isMissing(uri: vscode.Uri): boolean;
    setComparisonFileSource(source: {
      onDidChange: vscode.Event<void>;
      getEntries(): readonly { uri: vscode.Uri; status?: string }[];
    }): void;
    setPullRequestFileSource(source: {
      onDidChangePullRequestData: vscode.Event<void>;
      getCommentedUris(): readonly vscode.Uri[];
      getPullRequestFileUris(): readonly vscode.Uri[];
      getPullRequestFileEntries?(): readonly { uri: vscode.Uri; status?: string }[];
    }): void;
  };
  comparisonSource: {
    readonly onDidChange: vscode.Event<void>;
    getEntries(): readonly { uri: vscode.Uri; status?: string }[];
  };
  pullRequestCommentDecorations: {
    readonly onDidChangePullRequestData: vscode.Event<void>;
    getCommentedUris(): readonly vscode.Uri[];
    getPullRequestFileUris(): readonly vscode.Uri[];
    getPullRequestFileEntries(): readonly { uri: vscode.Uri; status?: string }[];
  };
  tabView: vscode.TreeView<unknown>;
  explorerView: vscode.TreeView<unknown>;
  projectsView: vscode.TreeView<unknown>;
}

const root = process.env.TAB_MANAGER_E2E_ROOT!;
const workspaceRoot = process.env.TAB_MANAGER_E2E_WORKSPACE!;

suite('Tab Manager E2E', () => {
  let api: TestApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateExtension();
    await resetState(api);
  });

  setup(async function () {
    this.timeout(30_000);
    await closeAllEditors();
    await resetState(api);
  });

  test('registers every contributed command plus internal tree commands', async () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const expected = [
      ...packageJson.contributes.commands.map((entry: { command: string }) => entry.command),
      'tabManager.openTab',
      'tabManager.explorer.open',
    ];
    const commands = await vscode.commands.getCommands(true);

    for (const command of expected) {
      assert.ok(commands.includes(command), `Expected command to be registered: ${command}`);
    }
  });

  test('uses native menu fields and the planned view hierarchy', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.strictEqual(packageJson.contributes.configurationDefaults, undefined);
    assert.strictEqual(packageJson.contributes.views.explorer[0].name, 'Extended Explorer');

    const supportedMenuFields = new Set(['command', 'alt', 'when', 'group']);
    for (const [menuId, items] of Object.entries(packageJson.contributes.menus)) {
      for (const item of items as Array<Record<string, unknown>>) {
        for (const field of Object.keys(item)) {
          assert.ok(
            supportedMenuFields.has(field),
            `Unsupported menu field "${field}" in ${menuId}`,
          );
        }
      }
    }

    const titleItems = packageJson.contributes.menus['view/title'] as Array<{
      command: string;
      when?: string;
      group?: string;
    }>;
    const closeSelected = titleItems.find(
      (item) => item.command === 'tabManager.closeSelected',
    );
    assert.ok(closeSelected?.when?.includes('tabManager.hasSelectedTabs'));
    const showComparison = titleItems.find((item) =>
      item.command === 'tabManager.filter.comparison' &&
      item.when?.includes("filterMode != 'comparison'"),
    );
    assert.ok(showComparison?.when?.includes('tabManager.hasActiveComparison'));

    const navigation = titleItems.filter((item) => item.group?.startsWith('navigation'));
    assert.deepStrictEqual(
      navigation
        .filter((item) => item.when?.includes('view == tabManagerView'))
        .map((item) => item.command)
        .sort(),
      [
        'tabManager.closeSelected',
        'tabManager.createGroup',
        'tabManager.layout.byColumn',
        'tabManager.layout.merged',
      ].sort(),
    );
    assert.deepStrictEqual(
      navigation
        .filter((item) => item.when?.includes('view == tabManagerExplorer'))
        .map((item) => item.command)
        .sort(),
      [
        'tabManager.explorer.newFile',
        'tabManager.explorer.newFolder',
        'tabManager.explorer.refresh',
        'tabManager.explorer.revealActive',
      ].sort(),
    );
    assert.ok(!navigation.some((item) => item.command.startsWith('tabManager.filter.')));
    assert.strictEqual(
      titleItems.filter((item) => item.command === 'tabManager.filter.comparison').length,
      1,
    );
    assert.strictEqual(
      titleItems.filter((item) => item.command === 'tabManager.filter.clearComparison').length,
      1,
    );
    assert.ok(!titleItems.some((item) => item.command === 'tabManager.filter.clear'));
    assert.strictEqual(
      titleItems.find((item) => item.command === 'tabManager.explorer.refreshPullRequestComments')
        ?.group,
      '4_refresh@1',
    );
    assert.strictEqual(
      titleItems.find((item) => item.command === 'tabManager.explorer.expandAll')?.group,
      '5_tree@1',
    );

    const filterOrder: Array<[string, string]> = [
      ['modified', '3_filter@1'],
      ['untracked', '3_filter@2'],
      ['deleted', '3_filter@3'],
      ['errors', '3_filter@4'],
      ['tabsOnly', '3_filter@5'],
      ['unsaved', '3_filter@6'],
      ['readOnly', '3_filter@7'],
      ['prComments', '3_filter@8'],
      ['prFiles', '3_filter@9'],
      ['comparison', '3_filter@10'],
    ];
    for (const [mode, group] of filterOrder) {
      const title = mode[0].toUpperCase() + mode.slice(1);
      const show = `tabManager.filter.${mode}`;
      const clear = `tabManager.filter.clear${title}`;
      assert.strictEqual(titleItems.find((item) => item.command === show)?.group, group);
      assert.strictEqual(titleItems.find((item) => item.command === clear)?.group, group);
    }

    assert.deepStrictEqual(
      packageJson.contributes.viewsWelcome.map((item: { view: string; contents: string; when?: string }) => [
        item.view,
        item.contents,
        item.when,
      ]),
      [
        ['tabManagerView', 'No tabs are open.', '!tabManager.hasActiveFilter'],
        [
          'tabManagerView',
          'No open tabs match the active filter.\n[Clear Filter](command:tabManager.filter.clear)',
          'tabManager.hasActiveFilter',
        ],
        [
          'tabManagerExplorer',
          'Open a folder or workspace to browse files.\n[Open Folder](command:vscode.openFolder)',
          'workbenchState == empty',
        ],
        [
          'tabManagerExplorer',
          'No files match the active filter.\n[Clear Filter](command:tabManager.filter.clear)',
          'workbenchState != empty && tabManager.hasActiveFilter',
        ],
        [
          'tabManagerExplorer',
          'No files or folders are in this workspace.',
          'workbenchState != empty && !tabManager.hasActiveFilter',
        ],
        [
          'tabManagerProjects',
          'No saved projects.\n[Add Project Folder](command:tabManager.projects.addFolder)',
          'workbenchState == empty',
        ],
        [
          'tabManagerProjects',
          'No saved projects.\n[Add Current Workspace](command:tabManager.projects.addCurrentWorkspace)\nOr [add another folder](command:tabManager.projects.addFolder).',
          'workbenchState != empty',
        ],
      ],
    );
  });

  test('executes state-specific clear, hide, and stop aliases safely', async () => {
    const filterAliases: Array<[Exclude<FilterMode, 'none'>, string, string]> = [
      ['modified', 'tabManager.filter.modified', 'tabManager.filter.clearModified'],
      ['untracked', 'tabManager.filter.untracked', 'tabManager.filter.clearUntracked'],
      ['deleted', 'tabManager.filter.deleted', 'tabManager.filter.clearDeleted'],
      ['errors', 'tabManager.filter.errors', 'tabManager.filter.clearErrors'],
      ['tabsOnly', 'tabManager.filter.tabsOnly', 'tabManager.filter.clearTabsOnly'],
      ['unsaved', 'tabManager.filter.unsaved', 'tabManager.filter.clearUnsaved'],
      ['readOnly', 'tabManager.filter.readOnly', 'tabManager.filter.clearReadOnly'],
      ['prComments', 'tabManager.filter.prComments', 'tabManager.filter.clearPrComments'],
      ['prFiles', 'tabManager.filter.prFiles', 'tabManager.filter.clearPrFiles'],
      ['comparison', 'tabManager.filter.comparison', 'tabManager.filter.clearComparison'],
    ];
    for (const [mode, showCommand, clearCommand] of filterAliases) {
      await vscode.commands.executeCommand(showCommand);
      assert.strictEqual(api.store.getFilterMode(), mode);
      await vscode.commands.executeCommand(clearCommand);
      assert.strictEqual(api.store.getFilterMode(), 'none');
      await vscode.commands.executeCommand(clearCommand);
      assert.strictEqual(api.store.getFilterMode(), 'none');
    }

    await vscode.commands.executeCommand('tabManager.explorer.toggleFileSize');
    await vscode.commands.executeCommand('tabManager.explorer.hideFileSize');
    assert.strictEqual(api.store.getExplorerDisplayOptions().fileSize, false);
    await vscode.commands.executeCommand('tabManager.explorer.hideFileSize');
    assert.strictEqual(api.store.getExplorerDisplayOptions().fileSize, false);

    await vscode.commands.executeCommand('tabManager.explorer.toggleLineCount');
    await vscode.commands.executeCommand('tabManager.explorer.hideLineCount');
    assert.strictEqual(api.store.getExplorerDisplayOptions().lineCount, false);

    await vscode.commands.executeCommand('tabManager.sort.toggleType');
    await vscode.commands.executeCommand('tabManager.sort.stopType');
    assert.strictEqual(api.store.getSortState().type, false);
    await vscode.commands.executeCommand('tabManager.sort.stopType');
    assert.strictEqual(api.store.getSortState().type, false);

    await vscode.commands.executeCommand('tabManager.sort.toggleReadOnly');
    await vscode.commands.executeCommand('tabManager.sort.stopReadOnly');
    assert.strictEqual(api.store.getSortState().readOnly, false);
  });

  test('describes the active layout, filter, and sort state in each view', async () => {
    const workspaceName = vscode.workspace.name;
    try {
      await vscode.commands.executeCommand('tabManager.layout.byColumn');
      await waitFor(
        () => api.tabView.description === 'By Column' || false,
        'default Open Tabs description',
      );
      assert.strictEqual(api.explorerView.description, workspaceName);

      await vscode.commands.executeCommand('tabManager.layout.merged');
      await waitFor(
        () => api.tabView.description === 'All Columns' || false,
        'merged Open Tabs description',
      );

      await vscode.commands.executeCommand('tabManager.filter.modified');
      await waitFor(
        () => api.tabView.description === 'All Columns · Filter: Modified' || false,
        'modified Open Tabs description',
      );
      assert.strictEqual(
        api.explorerView.description,
        `${workspaceName} · Filter: Modified`,
      );

      await vscode.commands.executeCommand('tabManager.sort.nameAsc');
      await vscode.commands.executeCommand('tabManager.sort.toggleType');
      await vscode.commands.executeCommand('tabManager.sort.toggleReadOnly');
      await waitFor(
        () =>
          api.tabView.description ===
            'All Columns · Filter: Modified · Sort: Name A–Z, Type, Read-only first' ||
          false,
        'sorted Open Tabs description',
      );
      assert.strictEqual(
        api.explorerView.description,
        `${workspaceName} · Filter: Modified · Sort: Name A–Z, Type`,
      );

      await vscode.commands.executeCommand('tabManager.sort.nameDesc');
      await waitFor(
        () => api.tabView.description?.includes('Sort: Name Z–A, Type, Read-only first') || false,
        'descending sort description',
      );

      await vscode.commands.executeCommand('tabManager.filter.tabsOnly');
      await waitFor(
        () => api.tabView.description?.includes('Filter: Open Tabs') || false,
        'Open Tabs filter label',
      );
    } finally {
      await vscode.commands.executeCommand('tabManager.filter.clear');
      await vscode.commands.executeCommand('tabManager.sort.nameNone');
      await vscode.commands.executeCommand('tabManager.sort.stopType');
      await vscode.commands.executeCommand('tabManager.sort.stopReadOnly');
      await vscode.commands.executeCommand('tabManager.layout.byColumn');
    }
  });

  test('renders recoverable Explorer read errors as non-interactive tree items', async () => {
    const folder = vscode.Uri.file(path.join(workspaceRoot, 'blocked-folder'));
    const node = new ExplorerErrorNode(folder, 'Permission denied');
    assert.strictEqual(label(node), 'Unable to read folder');
    assert.strictEqual(description(node), 'blocked-folder');
    assert.strictEqual(node.id, `error:${folder.toString()}`);
    assert.strictEqual(node.contextValue, 'explorerError');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, 'error');
    assert.strictEqual(node.command, undefined);
    assert.strictEqual(node.resourceUri, undefined);
    assert.strictEqual(node.tooltip, `${folder.fsPath}\nPermission denied`);
    assert.deepStrictEqual(node.accessibilityInformation, {
      label: 'Unable to read folder blocked-folder. Permission denied',
      role: 'treeitem',
    });

    const transfer = new vscode.DataTransfer();
    api.explorerProvider.handleDrag([node], transfer);
    assert.strictEqual(transfer.get('text/uri-list'), undefined);
    await api.explorerProvider.handleDrop(node, transfer);
  });

  test('shows view-scoped progress while refreshing Explorer files', async () => {
    let progressOptions: vscode.ProgressOptions | undefined;
    await withWindowStub(
      'withProgress',
      async (
        options: vscode.ProgressOptions,
        task: (
          progress: vscode.Progress<{ message?: string }>,
          token: vscode.CancellationToken,
        ) => Thenable<unknown>,
      ) => {
        progressOptions = options;
        const cancellation = new vscode.CancellationTokenSource();
        try {
          return await task({ report: () => undefined }, cancellation.token);
        } finally {
          cancellation.dispose();
        }
      },
      () => vscode.commands.executeCommand('tabManager.explorer.refresh'),
    );
    assert.deepStrictEqual(progressOptions, {
      location: { viewId: 'tabManagerExplorer' },
      title: 'Refreshing files…',
    });
  });

  test('does not fail node-scoped commands when invoked without tree context', async () => {
    await expectNoCommandFailure('openTab without a tree node', () =>
      vscode.commands.executeCommand('tabManager.openTab'),
    );
    await expectNoCommandFailure('renameGroup without a tree node', () =>
      vscode.commands.executeCommand('tabManager.renameGroup'),
    );
    await expectNoCommandFailure('deleteGroup without a tree node', () =>
      vscode.commands.executeCommand('tabManager.deleteGroup'),
    );
  });

  test('covers tab layout, sorting, group lifecycle, open, and close behavior', async () => {
    const alpha = uri('alpha.ts');
    const zeta = uri('zeta.txt');
    await openFile(alpha, vscode.ViewColumn.One);
    await openFile(zeta, vscode.ViewColumn.Beside);

    await vscode.commands.executeCommand('tabManager.layout.byColumn');
    assert.strictEqual(api.store.getTabLayoutMode(), 'byColumn');
    const columns = await tabRoots(api);
    assert.deepStrictEqual(new Set(labels(columns)), new Set(['Column 1', 'Column 2']));
    assert.strictEqual(description(columns.find((node) => label(node) === 'Column 1')), '1 tab');
    assert.strictEqual(
      description(columns.find((node) => label(node) === 'Column 2')),
      'active · 1 tab',
    );

    await vscode.commands.executeCommand('tabManager.layout.merged');
    assert.strictEqual(api.store.getTabLayoutMode(), 'merged');

    await vscode.commands.executeCommand('tabManager.sort.nameAsc');
    assert.deepStrictEqual(labels(await tabRoots(api)), ['alpha.ts', 'zeta.txt']);

    await vscode.commands.executeCommand('tabManager.sort.nameDesc');
    assert.deepStrictEqual(labels(await tabRoots(api)), ['zeta.txt', 'alpha.ts']);

    await vscode.commands.executeCommand('tabManager.sort.nameNone');
    assert.strictEqual(api.store.getSortState().name, 'none');

    await vscode.commands.executeCommand('tabManager.sort.toggleType');
    assert.strictEqual(api.store.getSortState().type, true);

    await vscode.commands.executeCommand('tabManager.sort.toggleReadOnly');
    assert.strictEqual(api.store.getSortState().readOnly, true);

    await withInputBox('Work', () => vscode.commands.executeCommand('tabManager.createGroup'));
    assert.deepStrictEqual(
      api.store.getGroups().map((g) => g.name),
      ['Work'],
    );

    let roots = await tabRoots(api);
    const ungrouped = roots.find((node) => label(node) === 'Ungrouped');
    assert.ok(ungrouped, 'Expected Ungrouped header after creating a group.');
    assert.strictEqual(description(ungrouped), '2 tabs');
    const alphaNode = (await tabChildren(api, ungrouped)).find((node) => label(node) === 'alpha.ts');
    assert.ok(alphaNode, 'Expected alpha.ts under Ungrouped.');

    await withQuickPick(
      (items) => items.find((item) => item.label === 'Work'),
      () => vscode.commands.executeCommand('tabManager.addToGroup', alphaNode),
    );
    assert.strictEqual(api.store.getGroups()[0].tabKeys.length, 1);

    roots = await tabRoots(api);
    let groupNode = roots.find((node) => label(node) === 'Work');
    assert.ok(groupNode, 'Expected Work group node.');
    assert.strictEqual(description(groupNode), '1 tab');
    let groupedAlpha = (await tabChildren(api, groupNode)).find((node) => label(node) === 'alpha.ts');
    assert.ok(groupedAlpha, 'Expected alpha.ts inside Work group.');

    await vscode.commands.executeCommand('tabManager.removeFromGroup', groupedAlpha);
    assert.strictEqual(api.store.getGroups()[0].tabKeys.length, 0);

    groupNode = (await tabRoots(api)).find((node) => label(node) === 'Work');
    await withInputBox('Renamed', () =>
      vscode.commands.executeCommand('tabManager.renameGroup', groupNode),
    );
    assert.strictEqual(api.store.getGroups()[0].name, 'Renamed');

    groupNode = (await tabRoots(api)).find((node) => label(node) === 'Renamed');
    await withWarningMessage('Delete', () =>
      vscode.commands.executeCommand('tabManager.deleteGroup', groupNode),
    );
    assert.strictEqual(api.store.getGroups().length, 0);

    await openFile(zeta, vscode.ViewColumn.Beside);
    await waitFor(() => activeTabUri()?.toString() === zeta.toString(), 'zeta.txt to become active');
    const openAlphaNode = (await tabRoots(api)).find((node) => label(node) === 'alpha.ts');
    assert.strictEqual(
      (openAlphaNode as vscode.TreeItem).tooltip,
      `${alpha.fsPath}\nStatus: active, Column 1\nOpen Tab`,
    );
    assert.deepStrictEqual((openAlphaNode as vscode.TreeItem).accessibilityInformation, {
      label: `alpha.ts, ${alpha.fsPath}, Column 1, active tab, Open Tab`,
      role: 'treeitem',
    });
    await vscode.commands.executeCommand('tabManager.openTab', openAlphaNode);
    await waitFor(() => activeTabUri()?.toString() === alpha.toString(), 'alpha.ts to become active');

    await vscode.commands.executeCommand('tabManager.closeTab', openAlphaNode);
    await waitFor(() => !hasOpenTab(alpha), 'alpha.ts tab to close');

    const staleZetaNode = (await tabRoots(api)).find((node) => label(node) === 'zeta.txt');
    assert.ok(staleZetaNode, 'Expected zeta.txt node before recreating its tab.');
    await closeAllEditors();
    await openFile(zeta);
    await vscode.commands.executeCommand('tabManager.closeTab', staleZetaNode);
    await waitFor(() => !hasOpenTab(zeta), 'reopened zeta.txt tab to close from a stale tree node');
  });

  test('refreshes changed tab metadata without a manual tree refresh', async () => {
    const target = uri('alpha.ts');
    await openFile(target);
    await sleep(150);

    let treeChanges = 0;
    const subscription = api.tabProvider.onDidChangeTreeData(() => treeChanges++);
    try {
      await editOpenDocument(target, '// live unsaved state\n');
      await waitFor(() => treeChanges > 0 || false, 'tab tree change after editing a tab');

      const nodes = [...(await api.tabProvider.getChildren(undefined))];
      const targetNode = nodes.find((node) => label(node) === 'alpha.ts');
      assert.ok(targetNode, 'Expected alpha.ts in the tab tree.');
      assert.ok(
        description(targetNode).split(' · ').includes('unsaved'),
        'Expected the tab tree to show the unsaved state without a manual refresh.',
      );
    } finally {
      subscription.dispose();
      await vscode.window.activeTextEditor?.document.save();
    }
  });

  test('tracks an externally deleted open file outside expanded explorer folders', async () => {
    const directory = uri('live-file-state');
    const target = uri('live-file-state/external-delete.txt');
    fs.mkdirSync(directory.fsPath, { recursive: true });
    fs.writeFileSync(target.fsPath, 'live\n');
    await openFile(target);
    await sleep(150);
    assert.strictEqual(api.filterSource.isMissing(target), false);

    let treeChanges = 0;
    const subscription = api.tabProvider.onDidChangeTreeData(() => treeChanges++);
    try {
      fs.rmSync(target.fsPath);
      await waitFor(
        () => api.filterSource.isMissing(target),
        'external deletion to invalidate the cached open-file state',
      );
      await waitFor(() => treeChanges > 0 || false, 'tab tree change after external deletion');

      const nodes = [...(await api.tabProvider.getChildren(undefined))];
      const targetNode = nodes.find((node) => label(node) === 'external-delete.txt');
      assert.ok(targetNode, 'Expected the deleted file to remain represented by its open tab.');
      assert.ok(
        description(targetNode).split(' · ').includes('missing'),
        'Expected the open tab to show the missing state without expanding its Explorer folder.',
      );
    } finally {
      subscription.dispose();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      fs.rmSync(directory.fsPath, { recursive: true, force: true });
    }
  });

  test('keeps the tab view in sync while many tabs are opened and closed', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('tabManager.layout.merged');
    await vscode.commands.executeCommand('tabManager.sort.nameAsc');

    const bulkDir = uri('bulk-tabs');
    fs.mkdirSync(bulkDir.fsPath, { recursive: true });
    const bulkFiles = Array.from({ length: 32 }, (_, index) => {
      const relativePath = `bulk-tabs/tab-${String(index + 1).padStart(2, '0')}.txt`;
      const target = uri(relativePath);
      fs.writeFileSync(target.fsPath, `bulk tab ${index + 1}\n`);
      return target;
    });

    for (let index = 0; index < bulkFiles.length; index++) {
      await openFile(bulkFiles[index], index % 2 === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Beside);
    }

    await waitFor(
      () => bulkFiles.every((target) => hasOpenTab(target)),
      'all bulk tabs to open',
    );
    await waitFor(
      async () => {
        const rootLabels = labels(await tabRoots(api));
        return bulkFiles.every((target) => rootLabels.includes(baseName(target)));
      },
      'tab manager tree to list every bulk tab',
    );

    await vscode.commands.executeCommand('tabManager.layout.byColumn');
    const columns = await tabRoots(api);
    assert.ok(columns.length >= 2, 'Expected bulk tabs to be split across editor columns.');
    let columnTotal = 0;
    for (const column of columns) {
      columnTotal += (await tabChildren(api, column)).length;
    }
    assert.strictEqual(columnTotal, bulkFiles.length);

    await vscode.commands.executeCommand('tabManager.filter.tabsOnly');
    const bulkFolder = await waitForExplorerNode(api, 'bulk-tabs');
    const filteredChildren = await explorerChildren(api, bulkFolder);
    assert.strictEqual(filteredChildren.length, bulkFiles.length);

    await vscode.commands.executeCommand('tabManager.layout.merged');
    await vscode.commands.executeCommand('tabManager.filter.clear');
    const nodesBeforeClose = await tabRoots(api);
    for (const target of bulkFiles.slice(0, 16)) {
      const node = nodesBeforeClose.find((candidate) => label(candidate) === baseName(target));
      assert.ok(node, `Expected Tab Manager node for ${baseName(target)}.`);
      await vscode.commands.executeCommand('tabManager.closeTab', node);
    }

    await waitFor(
      () =>
        bulkFiles.slice(0, 16).every((target) => !hasOpenTab(target)) &&
        bulkFiles.slice(16).every((target) => hasOpenTab(target)),
      'first half of bulk tabs to close through Tab Manager',
    );

    await closeAllEditors();
    await waitFor(
      async () => (await tabRoots(api)).filter((node) => label(node).startsWith('tab-')).length === 0,
      'bulk tabs to disappear after closing all editors',
    );
  });

  test('does not fail commands when tab and explorer nodes become stale', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('tabManager.filter.clear');

    const stabilityDir = uri('stability');
    fs.mkdirSync(stabilityDir.fsPath, { recursive: true });

    const staleTabUri = uri('stability/stale-tab.txt');
    fs.writeFileSync(staleTabUri.fsPath, 'stale tab\n');
    await openFile(staleTabUri);
    const staleTabNode = (await tabRoots(api)).find((node) => label(node) === 'stale-tab.txt');
    assert.ok(staleTabNode, 'Expected stale-tab.txt in the tab tree.');

    await closeAllEditors();
    await expectNoCommandFailure('closeTab with a node whose tab is already gone', () =>
      vscode.commands.executeCommand('tabManager.closeTab', staleTabNode),
    );
    await expectNoCommandFailure('openTab with a stale node should reopen the resource', () =>
      vscode.commands.executeCommand('tabManager.openTab', staleTabNode),
    );
    await waitFor(() => hasOpenTab(staleTabUri), 'stale tab node to reopen its file');

    await closeAllEditors();
    await openFile(staleTabUri);
    await expectNoCommandFailure('closeTab with a stale node after the file is reopened', () =>
      vscode.commands.executeCommand('tabManager.closeTab', staleTabNode),
    );
    await waitFor(() => !hasOpenTab(staleTabUri), 'reopened stale tab to close');

    const staleFileUri = uri('stability/stale-file.txt');
    fs.writeFileSync(staleFileUri.fsPath, 'stale explorer file\n');
    api.explorerProvider.refresh();
    const stabilityNode = await waitForExplorerNode(api, 'stability');
    const staleFileNode = await waitForExplorerNode(api, 'stale-file.txt', stabilityDir);
    fs.rmSync(staleFileUri.fsPath);

    await withErrorMessage(undefined, () =>
      expectNoCommandFailure('open a stale Explorer file node', () =>
        vscode.commands.executeCommand('tabManager.explorer.open', staleFileNode),
      ),
    );
    await withErrorMessage(undefined, () =>
      withInputBox('renamed-stale-file.txt', () =>
        expectNoCommandFailure('rename a stale Explorer file node', () =>
          vscode.commands.executeCommand('tabManager.explorer.rename', staleFileNode),
        ),
      ),
    );
    await withErrorMessage(undefined, () =>
      withWarningMessage('Delete', () =>
        expectNoCommandFailure('delete a stale Explorer file node', () =>
          vscode.commands.executeCommand('tabManager.explorer.delete', staleFileNode),
        ),
      ),
    );

    await expectNoCommandFailure('copy a stale Explorer node into the extension clipboard', () =>
      vscode.commands.executeCommand('tabManager.explorer.copy', staleFileNode),
    );
    await withErrorMessage(undefined, () =>
      expectNoCommandFailure('paste a stale Explorer clipboard source', () =>
        vscode.commands.executeCommand('tabManager.explorer.paste', stabilityNode),
      ),
    );
    assert.ok(fs.existsSync(stabilityDir.fsPath), 'Stability fixture folder should remain usable.');
  });

  test('survives rapid filter, sort, layout, and refresh commands during tab churn', async function () {
    this.timeout(60_000);
    const churnDir = uri('stability-churn');
    fs.mkdirSync(churnDir.fsPath, { recursive: true });
    const churnFiles = Array.from({ length: 12 }, (_, index) => {
      const target = uri(`stability-churn/churn-${String(index + 1).padStart(2, '0')}.txt`);
      fs.writeFileSync(target.fsPath, `churn ${index + 1}\n`);
      return target;
    });

    for (const target of churnFiles) {
      await openFile(target, vscode.ViewColumn.Active);
    }
    await waitFor(() => churnFiles.every((target) => hasOpenTab(target)), 'churn tabs to open');

    const rapidCommands = [
      'tabManager.filter.tabsOnly',
      'tabManager.filter.clear',
      'tabManager.filter.unsaved',
      'tabManager.filter.clear',
      'tabManager.filter.comparison',
      'tabManager.filter.clear',
      'tabManager.sort.nameAsc',
      'tabManager.sort.nameDesc',
      'tabManager.sort.nameNone',
      'tabManager.sort.toggleType',
      'tabManager.sort.toggleType',
      'tabManager.layout.byColumn',
      'tabManager.layout.merged',
      'tabManager.explorer.refresh',
    ];

    await Promise.all(
      rapidCommands.map((command, index) =>
        expectNoCommandFailure(`rapid command ${index + 1}: ${command}`, () =>
          vscode.commands.executeCommand(command),
        ),
      ),
    );

    const nodes = await tabRoots(api);
    assert.ok(nodes.length > 0, 'Tab tree should remain readable after rapid command churn.');
    const explorerNodes = await explorerRoots(api);
    assert.ok(
      explorerNodes.some((node) => label(node) === 'stability-churn'),
      'Explorer tree should remain readable after rapid command churn.',
    );

    await closeAllEditors();
    await waitFor(
      async () =>
        (await tabRoots(api)).every((node) => !label(node).startsWith('churn-')),
      'churn tabs to disappear after closing all editors',
    );
  });

  test('prevents recursive folder paste from damaging user files', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('tabManager.filter.clear');

    const criticalRoot = uri('critical-paste');
    const parent = uri('critical-paste/parent');
    const child = uri('critical-paste/parent/child');
    const marker = uri('critical-paste/parent/marker.txt');
    fs.mkdirSync(child.fsPath, { recursive: true });
    fs.writeFileSync(marker.fsPath, 'still here\n');
    api.explorerProvider.refresh();

    const criticalRootNode = await waitForExplorerNode(api, 'critical-paste');
    const parentNode = await waitForExplorerNode(api, 'parent', criticalRoot);
    const childNode = await waitForExplorerNode(api, 'child', parent);

    await vscode.commands.executeCommand('tabManager.explorer.copy', parentNode);
    await withWarningMessage(undefined, () =>
      expectNoCommandFailure('copy/paste folder into its own child', () =>
        vscode.commands.executeCommand('tabManager.explorer.paste', childNode),
      ),
    );
    assert.ok(fs.existsSync(parent.fsPath), 'Copying into a child should leave the source folder intact.');
    assert.ok(!fs.existsSync(path.join(child.fsPath, 'parent')));
    assert.strictEqual(fs.readFileSync(marker.fsPath, 'utf8'), 'still here\n');

    await vscode.commands.executeCommand('tabManager.explorer.cut', parentNode);
    await withWarningMessage(undefined, () =>
      expectNoCommandFailure('cut/paste folder into its own child', () =>
        vscode.commands.executeCommand('tabManager.explorer.paste', childNode),
      ),
    );
    assert.ok(fs.existsSync(parent.fsPath), 'Moving into a child should leave the source folder intact.');
    assert.ok(!fs.existsSync(path.join(child.fsPath, 'parent')));
    assert.strictEqual(fs.readFileSync(marker.fsPath, 'utf8'), 'still here\n');

    await vscode.commands.executeCommand('tabManager.explorer.copy', parentNode);
    await withWarningMessage(undefined, () =>
      expectNoCommandFailure('copy/paste folder onto itself', () =>
        vscode.commands.executeCommand('tabManager.explorer.paste', parentNode),
      ),
    );
    assert.ok(!fs.existsSync(path.join(parent.fsPath, 'parent')));
    assert.ok((await explorerChildren(api, criticalRootNode)).some((node) => label(node) === 'parent'));
  });

  test('copies normalized mixed Explorer selections with progress and Finder-style names', async function () {
    this.timeout(60_000);
    const base = uri('copy-batch');
    const target = uri('copy-batch/target');
    const report = uri('copy-batch/report.txt');
    const dotfile = uri('copy-batch/.env');
    const folder = uri('copy-batch/folder.with.dot');
    const nested = uri('copy-batch/folder.with.dot/nested.txt');
    const sentinel = uri('copy-batch/sentinel.txt');
    fs.mkdirSync(target.fsPath, { recursive: true });
    fs.mkdirSync(folder.fsPath, { recursive: true });
    fs.writeFileSync(report.fsPath, 'report source\n');
    fs.writeFileSync(dotfile.fsPath, 'environment source\n');
    fs.writeFileSync(nested.fsPath, 'nested source\n');
    fs.writeFileSync(sentinel.fsPath, 'source sentinel\n');
    fs.writeFileSync(path.join(target.fsPath, 'sentinel.txt'), 'destination sentinel\n');
    api.explorerProvider.refresh();
    const targetNode = await waitForExplorerNode(api, 'target', base);

    await vscode.commands.executeCommand('tabManager.explorer.copy', undefined, [
      itemFor(report),
      itemFor(folder),
      itemFor(nested),
      itemFor(dotfile),
      itemFor(sentinel),
      itemFor(report),
    ]);

    const reports: string[] = [];
    let progressOptions: vscode.ProgressOptions | undefined;
    await withWindowStub(
      'withProgress',
      async (
        options: vscode.ProgressOptions,
        task: (progress: vscode.Progress<{ message?: string }>) => Thenable<unknown>,
      ) => {
        progressOptions = options;
        return task({ report: (value) => reports.push(value.message ?? '') });
      },
      () => vscode.commands.executeCommand('tabManager.explorer.paste', targetNode),
    );
    assert.deepStrictEqual(progressOptions, {
      location: { viewId: 'tabManagerExplorer' },
      title: 'Copying 4 items…',
    });
    assert.deepStrictEqual(reports, ['report.txt', 'folder.with.dot', '.env', 'sentinel.txt']);
    assert.strictEqual(fs.readFileSync(path.join(target.fsPath, 'report.txt'), 'utf8'), 'report source\n');
    assert.strictEqual(fs.readFileSync(path.join(target.fsPath, '.env'), 'utf8'), 'environment source\n');
    assert.strictEqual(
      fs.readFileSync(path.join(target.fsPath, 'folder.with.dot/nested.txt'), 'utf8'),
      'nested source\n',
    );
    assert.ok(!fs.existsSync(path.join(target.fsPath, 'nested.txt')));
    assert.strictEqual(fs.readFileSync(path.join(target.fsPath, 'sentinel.txt'), 'utf8'), 'destination sentinel\n');
    assert.strictEqual(
      fs.readFileSync(path.join(target.fsPath, 'sentinel copy.txt'), 'utf8'),
      'source sentinel\n',
    );

    await vscode.commands.executeCommand('tabManager.explorer.paste', targetNode);
    await vscode.commands.executeCommand('tabManager.explorer.paste', targetNode);
    for (const copied of [
      'report copy.txt',
      'report copy 2.txt',
      '.env copy',
      '.env copy 2',
      'folder.with.dot copy/nested.txt',
      'folder.with.dot copy 2/nested.txt',
    ]) {
      assert.ok(fs.existsSync(path.join(target.fsPath, copied)), `Expected ${copied} to be copied.`);
    }
    assert.strictEqual(fs.readFileSync(report.fsPath, 'utf8'), 'report source\n');
    assert.strictEqual(fs.readFileSync(nested.fsPath, 'utf8'), 'nested source\n');
  });

  test('pastes a selected copied folder beside itself and recovers a partial batch', async function () {
    this.timeout(60_000);
    const base = uri('copy-keyboard');
    const folder = uri('copy-keyboard/source-folder');
    const nested = uri('copy-keyboard/source-folder/nested.txt');
    fs.mkdirSync(folder.fsPath, { recursive: true });
    fs.writeFileSync(nested.fsPath, 'nested\n');
    api.explorerProvider.refresh();
    const folderNode = await waitForExplorerNode(api, 'source-folder', base);
    await api.explorerView.reveal(folderNode, { select: true, focus: true });
    await vscode.commands.executeCommand('tabManager.explorer.copy');
    await vscode.commands.executeCommand('tabManager.explorer.paste');
    await waitFor(
      () => fs.existsSync(path.join(base.fsPath, 'source-folder copy/nested.txt')),
      'selected folder to be copied beside itself',
    );
    assert.ok(!fs.existsSync(path.join(folder.fsPath, 'source-folder')));

    const target = uri('copy-keyboard/recovery-target');
    const valid = uri('copy-keyboard/recovery-valid.txt');
    const missing = uri('copy-keyboard/recovery-missing.txt');
    fs.mkdirSync(target.fsPath, { recursive: true });
    fs.writeFileSync(valid.fsPath, 'valid\n');
    api.explorerProvider.refresh();
    const recoveryTargetNode = await waitForExplorerNode(api, 'recovery-target', base);
    const errors: string[] = [];
    await vscode.commands.executeCommand('tabManager.explorer.copy', undefined, [itemFor(valid), itemFor(missing)]);
    await withWindowStub(
      'showErrorMessage',
      (message: string) => {
        errors.push(message);
        return Promise.resolve(undefined);
      },
      () => vscode.commands.executeCommand('tabManager.explorer.paste', recoveryTargetNode),
    );
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('recovery-missing.txt'));
    assert.strictEqual(fs.readFileSync(path.join(target.fsPath, 'recovery-valid.txt'), 'utf8'), 'valid\n');
    assert.ok(!fs.existsSync(path.join(target.fsPath, 'recovery-missing.txt')));

    fs.writeFileSync(missing.fsPath, 'recovered\n');
    await vscode.commands.executeCommand('tabManager.explorer.paste', recoveryTargetNode);
    assert.strictEqual(fs.readFileSync(path.join(target.fsPath, 'recovery-missing.txt'), 'utf8'), 'recovered\n');
    assert.strictEqual(fs.readFileSync(path.join(target.fsPath, 'recovery-valid copy.txt'), 'utf8'), 'valid\n');
  });

  test('recovers from persisted state after reload and ignores corrupted state', async function () {
    this.timeout(30_000);
    await withInputBox('Persisted Group', () =>
      vscode.commands.executeCommand('tabManager.createGroup'),
    );
    await vscode.commands.executeCommand('tabManager.sort.nameDesc');
    await vscode.commands.executeCommand('tabManager.sort.toggleType');
    await vscode.commands.executeCommand('tabManager.filter.tabsOnly');
    await vscode.commands.executeCommand('tabManager.layout.byColumn');
    await vscode.commands.executeCommand('tabManager.explorer.toggleFileSize');
    await vscode.commands.executeCommand('tabManager.explorer.toggleLineCount');

    let reloaded = new GroupStore(api.context);
    assert.deepStrictEqual(
      reloaded.getGroups().map((group) => group.name),
      ['Persisted Group'],
    );
    assert.deepStrictEqual(reloaded.getSortState(), { name: 'desc', type: true, readOnly: false });
    assert.strictEqual(reloaded.getFilterMode(), 'tabsOnly');
    assert.strictEqual(reloaded.getTabLayoutMode(), 'byColumn');
    assert.deepStrictEqual(reloaded.getExplorerDisplayOptions(), {
      fileSize: true,
      lineCount: true,
    });

    await api.context.workspaceState.update('tabManager.groups', [
      null,
      { id: '', name: 'bad', tabKeys: [] },
      { id: 'valid', name: 'Recovered', tabKeys: ['text::one', 42, 'text::one'] },
      { id: 'valid', name: 'Duplicate', tabKeys: ['text::two'] },
    ]);
    await api.context.workspaceState.update('tabManager.sortState', {
      name: 'sideways',
      type: 'yes',
      readOnly: 'no',
    });
    await api.context.workspaceState.update('tabManager.filterMode', 'not-a-filter');
    await api.context.workspaceState.update('tabManager.tabLayoutMode', 'floating');
    await api.context.workspaceState.update('tabManager.explorerDisplayOptions', {
      fileSize: 'yes',
      lineCount: 1,
    });

    reloaded = new GroupStore(api.context);
    assert.deepStrictEqual(reloaded.getGroups(), [
      { id: 'valid', name: 'Recovered', tabKeys: ['text::one'] },
    ]);
    assert.deepStrictEqual(reloaded.getSortState(), { name: 'none', type: false, readOnly: false });
    assert.strictEqual(reloaded.getFilterMode(), 'none');
    assert.strictEqual(reloaded.getTabLayoutMode(), 'byColumn');
    assert.deepStrictEqual(reloaded.getExplorerDisplayOptions(), {
      fileSize: false,
      lineCount: false,
    });
  });

  test('toggles explorer file metadata descriptions', async function () {
    this.timeout(30_000);

    const target = uri('metadata.txt');
    fs.writeFileSync(target.fsPath, 'one\ntwo\n');

    assert.deepStrictEqual(api.store.getExplorerDisplayOptions(), {
      fileSize: false,
      lineCount: false,
    });
    assert.strictEqual(description(await waitForExplorerNode(api, 'metadata.txt')), '');

    await vscode.commands.executeCommand('tabManager.explorer.toggleFileSize');
    assert.deepStrictEqual(api.store.getExplorerDisplayOptions(), {
      fileSize: true,
      lineCount: false,
    });
    assert.strictEqual(description(await waitForExplorerNode(api, 'metadata.txt')), '8 B');

    await vscode.commands.executeCommand('tabManager.explorer.toggleLineCount');
    assert.deepStrictEqual(api.store.getExplorerDisplayOptions(), {
      fileSize: true,
      lineCount: true,
    });
    assert.strictEqual(
      description(await waitForExplorerNode(api, 'metadata.txt')),
      '8 B · 2 lines',
    );
    assert.deepStrictEqual(
      (await waitForExplorerNode(api, 'metadata.txt') as vscode.TreeItem).accessibilityInformation,
      {
        label: `metadata.txt, ${target.fsPath}, 8 B, 2 lines, Open File`,
        role: 'treeitem',
      },
    );

    await sleep(150);
    let treeChanges = 0;
    const subscription = api.explorerProvider.onDidChangeTreeData(() => treeChanges++);
    try {
      fs.appendFileSync(target.fsPath, 'three\n');
      await waitFor(() => treeChanges > 0 || false, 'explorer tree change after file content update');
      await waitFor(async () => {
        const nodes = [...(await api.explorerProvider.getChildren(undefined))];
        const node = nodes.find((candidate) => label(candidate) === 'metadata.txt');
        return node && description(node) === '14 B · 3 lines' ? true : false;
      }, 'live file metadata update without a manual explorer refresh');
    } finally {
      subscription.dispose();
    }

    await vscode.commands.executeCommand('tabManager.explorer.toggleFileSize');
    assert.deepStrictEqual(api.store.getExplorerDisplayOptions(), {
      fileSize: false,
      lineCount: true,
    });
    assert.strictEqual(description(await waitForExplorerNode(api, 'metadata.txt')), '3 lines');

    await vscode.commands.executeCommand('tabManager.explorer.toggleLineCount');
    assert.deepStrictEqual(api.store.getExplorerDisplayOptions(), {
      fileSize: false,
      lineCount: false,
    });
    assert.strictEqual(description(await waitForExplorerNode(api, 'metadata.txt')), '');
  });

  test('toggles all filter commands and reflects real filter sources', async function () {
    this.timeout(60_000);

    const modes: Array<[FilterMode, string]> = [
      ['modified', 'tabManager.filter.modified'],
      ['untracked', 'tabManager.filter.untracked'],
      ['deleted', 'tabManager.filter.deleted'],
      ['errors', 'tabManager.filter.errors'],
      ['tabsOnly', 'tabManager.filter.tabsOnly'],
      ['unsaved', 'tabManager.filter.unsaved'],
      ['readOnly', 'tabManager.filter.readOnly'],
      ['prComments', 'tabManager.filter.prComments'],
      ['prFiles', 'tabManager.filter.prFiles'],
      ['comparison', 'tabManager.filter.comparison'],
    ];

    for (const [mode, command] of modes) {
      await vscode.commands.executeCommand(command);
      assert.strictEqual(api.store.getFilterMode(), mode);
      await vscode.commands.executeCommand(command);
      assert.strictEqual(api.store.getFilterMode(), 'none');
    }

    const alpha = uri('alpha.ts');
    await openFile(alpha);
    await editOpenDocument(alpha, '// unsaved change\n');
    await waitFor(() => api.filterSource.matches(alpha, 'unsaved'), 'unsaved filter source');
    assert.ok(api.filterSource.matches(alpha, 'tabsOnly'));
    await vscode.window.activeTextEditor?.document.save();

    const diagnostics = vscode.languages.createDiagnosticCollection('tab-manager-e2e');
    const notes = uri('notes.md');
    diagnostics.set(notes, [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        'E2E diagnostic',
        vscode.DiagnosticSeverity.Error,
      ),
    ]);
    try {
      await waitFor(() => api.filterSource.matches(notes, 'errors'), 'errors filter source');
    } finally {
      diagnostics.dispose();
    }

    const readonly = uri('readonly.txt');
    fs.chmodSync(readonly.fsPath, 0o444);
    try {
      await openFile(readonly);
      await api.filterSource.refresh();
      assert.ok(api.filterSource.isReadOnly(vscode.Uri.parse('git:/readonly.txt')));
    } finally {
      fs.chmodSync(readonly.fsPath, 0o644);
    }

    const untracked = uri('untracked-filter.txt');
    fs.writeFileSync(untracked.fsPath, 'untracked\n');
    await api.filterSource.refresh();
    await waitFor(() => api.filterSource.matches(untracked, 'untracked'), 'untracked git source');

    const modified = uri('modified.txt');
    fs.appendFileSync(modified.fsPath, 'modified\n');
    await api.filterSource.refresh();
    await waitFor(() => api.filterSource.matches(modified, 'modified'), 'modified git source');

    const deleted = uri('delete-me.txt');
    fs.rmSync(deleted.fsPath);
    await api.filterSource.refresh();
    await waitFor(() => api.filterSource.matches(deleted, 'deleted'), 'deleted git source');

    await vscode.commands.executeCommand('tabManager.filter.deleted');
    const deletedRoots = await explorerRoots(api);
    assert.ok(
      deletedRoots.some((node) =>
        label(node) === strikeLabel('delete-me.txt') && description(node) === 'deleted'),
      'Expected deleted files to appear as ghost entries in the explorer.',
    );
  });

  test('tracks active comparisons and renders nested deleted ghosts for comparison and PR files', async function () {
    this.timeout(30_000);

    const changed = uri('alpha.ts');
    const removed = uri('comparison-ghost/nested/removed.ts');
    const normalizedComparisonEntries = comparisonEntriesFromSnapshot({
      version: 1,
      repoRoot: workspaceRoot,
      changes: [
        { status: 'M', path: 'alpha.ts' },
        { status: 'D', path: 'comparison-ghost/nested/removed.ts' },
        { status: 'D', path: '../outside.ts' },
        { status: 'A', path: '/absolute.ts' },
        { status: 'A', path: 'nested\\escape.ts' },
      ],
    });
    assert.deepStrictEqual(
      normalizedComparisonEntries.map((entry) => entry.uri.toString()),
      [changed.toString(), removed.toString()],
      'Comparison paths must stay beneath repoRoot.',
    );
    assert.deepStrictEqual(normalizedComparisonEntries[1].command, {
      command: 'gitSimpleCompare.openComparisonFile',
      title: 'Open Deleted File with Red Line Markers',
      arguments: [{ repoRoot: workspaceRoot, path: 'comparison-ghost/nested/removed.ts' }],
    });
    await openFile(changed);

    const comparisonEvent = new vscode.EventEmitter<void>();
    let comparisonEntries: readonly {
      uri: vscode.Uri;
      status?: string;
      command?: vscode.Command;
    }[] = [
      { uri: changed, status: 'M' },
      {
        uri: removed,
        status: 'D',
        command: {
          command: 'gitSimpleCompare.openComparisonFile',
          title: 'Open Deleted File with Red Line Markers',
          arguments: [{ repoRoot: workspaceRoot, path: 'comparison-ghost/nested/removed.ts' }],
        },
      },
    ];
    api.filterSource.setComparisonFileSource({
      onDidChange: comparisonEvent.event,
      getEntries: () => comparisonEntries,
    });

    try {
      await vscode.commands.executeCommand('tabManager.filter.comparison');
      await waitFor(() => api.filterSource.matches(changed, 'comparison'), 'comparison source');
      assert.deepStrictEqual(
        api.filterSource.getEntries('comparison').map((entry) => entry.status),
        ['M', 'D'],
      );

      const openTabs = await tabRoots(api);
      assert.ok(labels(openTabs).includes('alpha.ts'), 'Open Tabs should use the comparison filter.');

      const removedParent = uri('comparison-ghost/nested');
      const nestedChildren = await explorerChildrenForUri(api, removedParent);
      const deletedNode = nestedChildren.find((node) => description(node) === 'deleted');
      assert.ok(deletedNode, 'Expected a deleted comparison file under ghost directories.');
      assert.strictEqual(label(deletedNode), strikeLabel('removed.ts'));
      assert.deepStrictEqual(
        (deletedNode as vscode.TreeItem).accessibilityInformation,
        {
          label: 'removed.ts, deleted, Open Deleted File with Red Line Markers',
          role: 'treeitem',
        },
      );
      assert.strictEqual(
        (deletedNode as vscode.TreeItem).tooltip,
        `${removed.fsPath} (deleted)\nOpen Deleted File with Red Line Markers`,
      );
      assert.deepStrictEqual((deletedNode as vscode.TreeItem).command, {
        command: 'gitSimpleCompare.openComparisonFile',
        title: 'Open Deleted File with Red Line Markers',
        arguments: [{ repoRoot: workspaceRoot, path: 'comparison-ghost/nested/removed.ts' }],
      });

      comparisonEntries = [{ uri: changed, status: 'M' }];
      comparisonEvent.fire();
      await waitFor(
        () => !api.filterSource.matches(removed, 'comparison'),
        'comparison change event to invalidate filter caches',
      );
    } finally {
      api.filterSource.setComparisonFileSource(api.comparisonSource);
      comparisonEvent.dispose();
      await vscode.commands.executeCommand('tabManager.filter.clear');
    }

    const pullRequestEvent = new vscode.EventEmitter<void>();
    api.filterSource.setPullRequestFileSource({
      onDidChangePullRequestData: pullRequestEvent.event,
      getCommentedUris: () => [],
      getPullRequestFileUris: () => [removed],
      getPullRequestFileEntries: () => [{ uri: removed, status: 'removed' }],
    });
    try {
      await vscode.commands.executeCommand('tabManager.filter.prFiles');
      const nestedChildren = await explorerChildrenForUri(api, uri('comparison-ghost/nested'));
      assert.ok(
        nestedChildren.some((node) =>
          label(node) === strikeLabel('removed.ts') && description(node) === 'deleted'),
        'Expected GitHub removed files to reuse generic deleted ghost rendering.',
      );
    } finally {
      api.filterSource.setPullRequestFileSource(api.pullRequestCommentDecorations);
      pullRequestEvent.dispose();
      await vscode.commands.executeCommand('tabManager.filter.clear');
    }
  });

  test('covers explorer file commands, clipboard commands, compare, terminal, and drag-drop', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('tabManager.filter.clear');

    const initial = labels(await explorerRoots(api));
    assert.ok(initial.includes('alpha.ts'));
    assert.ok(initial.includes('folder'));

    const alpha = uri('alpha.ts');
    const alphaNode = (await explorerRoots(api)).find((node) => label(node) === 'alpha.ts');
    assert.strictEqual((alphaNode as vscode.TreeItem).tooltip, `${alpha.fsPath}\nOpen File`);
    assert.deepStrictEqual((alphaNode as vscode.TreeItem).accessibilityInformation, {
      label: `alpha.ts, ${alpha.fsPath}, Open File`,
      role: 'treeitem',
    });
    assert.strictEqual((alphaNode as vscode.TreeItem).command?.title, 'Open File');
    const projectNode = new ProjectNode({ uri: vscode.Uri.file(workspaceRoot) });
    assert.strictEqual(
      projectNode.tooltip,
      `${path.basename(workspaceRoot)}\n${workspaceRoot}\nOpen Project in New Window`,
    );
    assert.strictEqual(projectNode.description, path.basename(path.dirname(workspaceRoot)));
    assert.deepStrictEqual(projectNode.accessibilityInformation, {
      label: `${path.basename(workspaceRoot)}, ${workspaceRoot}, Open Project in New Window`,
      role: 'treeitem',
    });
    await vscode.commands.executeCommand('tabManager.explorer.open', alpha);
    await waitFor(() => activeUri()?.toString() === alpha.toString(), 'explorer open to focus alpha.ts');

    await vscode.commands.executeCommand('tabManager.explorer.openToSide', itemFor(uri('notes.md')));
    await waitFor(() => hasOpenTab(uri('notes.md')), 'open to side to open notes.md');

    await withCreateInputBox('created-from-command.txt', () =>
      vscode.commands.executeCommand('tabManager.explorer.newFile'),
    );
    const created = uri('created-from-command.txt');
    await waitFor(() => fs.existsSync(created.fsPath), 'new file command to create a file');
    await waitFor(() => activeUri()?.toString() === created.toString(), 'new file command to open the file');

    await withCreateInputBox('created-folder', () =>
      vscode.commands.executeCommand('tabManager.explorer.newFolder'),
    );
    const createdFolder = uri('created-folder');
    await waitFor(
      () => fs.existsSync(createdFolder.fsPath) && fs.statSync(createdFolder.fsPath).isDirectory(),
      'new folder command',
    );

    await withInputBox('renamed-from-command.md', () =>
      vscode.commands.executeCommand('tabManager.explorer.rename', itemFor(created)),
    );
    const renamed = uri('renamed-from-command.md');
    await waitFor(() => fs.existsSync(renamed.fsPath), 'rename command');

    await vscode.commands.executeCommand('tabManager.explorer.copyPath', itemFor(renamed));
    assert.strictEqual(await vscode.env.clipboard.readText(), renamed.fsPath);

    await vscode.commands.executeCommand('tabManager.explorer.copyRelativePath', itemFor(renamed));
    assert.strictEqual(await vscode.env.clipboard.readText(), 'renamed-from-command.md');

    await vscode.commands.executeCommand('tabManager.explorer.copy', itemFor(renamed));
    await vscode.commands.executeCommand('tabManager.explorer.paste');
    const copied = uri('renamed-from-command copy.md');
    await waitFor(() => fs.existsSync(copied.fsPath), 'copy/paste command');

    const folderNode = await explorerNode(api, 'created-folder');
    assert.ok(folderNode, 'Expected created-folder in explorer tree.');
    await vscode.commands.executeCommand('tabManager.explorer.cut', itemFor(copied));
    await vscode.commands.executeCommand('tabManager.explorer.paste', folderNode);
    await waitFor(
      () => fs.existsSync(path.join(createdFolder.fsPath, 'renamed-from-command copy.md')),
      'cut/paste command',
    );

    const terminalCount = vscode.window.terminals.length;
    await vscode.commands.executeCommand('tabManager.explorer.openInTerminal', folderNode);
    await waitFor(
      () => vscode.window.terminals.length === terminalCount + 1,
      'open in terminal command',
    );
    vscode.window.terminals[vscode.window.terminals.length - 1].dispose();

    const left = itemFor(uri('compare-left.txt'));
    const right = itemFor(uri('compare-right.txt'));
    await vscode.commands.executeCommand('tabManager.explorer.selectForCompare', left);
    await vscode.commands.executeCommand('tabManager.explorer.compareWithSelected', right);
    await waitFor(() => activeTabLabel().includes('compare-left.txt'), 'compare with selected command');

    await vscode.commands.executeCommand('tabManager.explorer.compareSelected', undefined, [left, right]);
    await waitFor(() => activeTabLabel().includes('compare-left.txt'), 'compare selected command');

    await vscode.commands.executeCommand('tabManager.explorer.findInFolder', folderNode);
    await vscode.commands.executeCommand('tabManager.explorer.revealActive');
    await vscode.commands.executeCommand('tabManager.explorer.expandAll');
    await vscode.commands.executeCommand('tabManager.explorer.refresh');

    const deleteTarget = uri('delete-command.tmp');
    fs.writeFileSync(deleteTarget.fsPath, 'delete\n');
    await withWarningMessage('Delete', () =>
      vscode.commands.executeCommand('tabManager.explorer.delete', itemFor(deleteTarget)),
    );
    await waitFor(() => !fs.existsSync(deleteTarget.fsPath), 'delete command');

    const dragSource = uri('drag-source.txt');
    fs.writeFileSync(dragSource.fsPath, 'drag\n');
    api.explorerProvider.refresh();
    const dragSourceNode = await explorerNode(api, 'drag-source.txt');
    const dragTargetNode = await explorerNode(api, 'created-folder');
    assert.ok(dragSourceNode, 'Expected drag source in explorer tree.');
    assert.ok(dragTargetNode, 'Expected drag target in explorer tree.');

    const transfer = new vscode.DataTransfer();
    api.explorerProvider.handleDrag([dragSourceNode], transfer);
    await api.explorerProvider.handleDrop(dragTargetNode, transfer);
    await waitFor(
      () => fs.existsSync(path.join(createdFolder.fsPath, 'drag-source.txt')),
      'drag/drop move behavior',
    );
  });

  test('compares an explorer file with a selected Git branch', async function () {
    this.timeout(30_000);

    const branchName = 'tab-manager-compare-base';
    const target = uri('alpha.ts');
    git(['branch', '-f', branchName, 'HEAD']);

    let diffArgs: unknown[] | undefined;
    try {
      fs.writeFileSync(target.fsPath, 'export const alpha = 2;\n');

      await withQuickPick(
        (items) => items.find((item) => item.label === branchName),
        () =>
          withCommandStub(async (original, command, ...args) => {
            if (command === 'vscode.diff') {
              diffArgs = args;
              return undefined;
            }
            return original(command, ...args);
          }, (execute) =>
            execute('tabManager.explorer.compareWithBranch', itemFor(target)),
          ),
      );
    } finally {
      fs.writeFileSync(target.fsPath, 'export const alpha = 1;\n');
    }

    assert.ok(diffArgs, 'Expected compare with branch to open a diff.');
    const [left, right, title] = diffArgs as [vscode.Uri, vscode.Uri, string];
    assert.strictEqual(left.scheme, 'git');
    assert.strictEqual(right.toString(), target.toString());
    assert.ok(title.includes(branchName), 'Expected diff title to include the selected branch.');

    const query = JSON.parse(left.query) as { path: string; ref: string };
    assert.strictEqual(query.path, target.fsPath);
    assert.strictEqual(query.ref, `refs/heads/${branchName}`);
  });

  test('handles likely Explorer edge cases from a user workflow', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('tabManager.filter.clear');

    const alpha = uri('alpha.ts');
    const alphaBefore = fs.readFileSync(alpha.fsPath, 'utf8');
    await withCreateInputBox('bad/name.txt', () =>
      vscode.commands.executeCommand('tabManager.explorer.newFile'),
    );
    assert.ok(!fs.existsSync(path.join(workspaceRoot, 'bad')));

    await withCreateInputBox('alpha.ts', () =>
      vscode.commands.executeCommand('tabManager.explorer.newFile'),
    );
    assert.strictEqual(fs.readFileSync(alpha.fsPath, 'utf8'), alphaBefore);

    const edgeDir = uri('explorer-edge');
    fs.mkdirSync(edgeDir.fsPath, { recursive: true });
    const renameSource = uri('explorer-edge/rename-source.txt');
    const renameExisting = uri('explorer-edge/rename-existing.txt');
    fs.writeFileSync(renameSource.fsPath, 'rename source\n');
    fs.writeFileSync(renameExisting.fsPath, 'rename existing\n');
    await withErrorMessage(undefined, () =>
      withInputBox('rename-existing.txt', () =>
        vscode.commands.executeCommand('tabManager.explorer.rename', itemFor(renameSource)),
      ),
    );
    assert.ok(fs.existsSync(renameSource.fsPath), 'Rename to an existing file should leave source in place.');
    assert.strictEqual(fs.readFileSync(renameExisting.fsPath, 'utf8'), 'rename existing\n');

    const deleteCancel = uri('explorer-edge/delete-cancel.txt');
    fs.writeFileSync(deleteCancel.fsPath, 'do not delete\n');
    await withWarningMessage('Cancel', () =>
      vscode.commands.executeCommand('tabManager.explorer.delete', itemFor(deleteCancel)),
    );
    assert.ok(fs.existsSync(deleteCancel.fsPath), 'Canceling delete should keep the file.');

    await vscode.commands.executeCommand('tabManager.explorer.delete', itemFor(vscode.Uri.file(workspaceRoot)));
    assert.ok(fs.existsSync(workspaceRoot), 'Workspace root should not be deleted.');

    const folderToCopy = uri('explorer-edge/folder-to-copy');
    fs.mkdirSync(folderToCopy.fsPath, { recursive: true });
    fs.writeFileSync(path.join(folderToCopy.fsPath, 'nested.txt'), 'nested\n');
    const edgeDirNode = await waitForExplorerNode(api, 'explorer-edge');
    await vscode.commands.executeCommand('tabManager.explorer.copy', itemFor(folderToCopy));
    await vscode.commands.executeCommand('tabManager.explorer.paste', edgeDirNode);
    const copiedFolderChild = uri('explorer-edge/folder-to-copy copy/nested.txt');
    await waitFor(() => fs.existsSync(copiedFolderChild.fsPath), 'recursive folder copy');

    const conflictSource = uri('explorer-edge/conflict.txt');
    const conflictDestDir = uri('explorer-edge/destination');
    const conflictDest = uri('explorer-edge/destination/conflict.txt');
    fs.mkdirSync(conflictDestDir.fsPath, { recursive: true });
    fs.writeFileSync(conflictSource.fsPath, 'source version\n');
    fs.writeFileSync(conflictDest.fsPath, 'destination version\n');
    api.explorerProvider.refresh();

    await withWarningMessage('Skip', async () => {
      const transfer = new vscode.DataTransfer();
      api.explorerProvider.handleDrag([await waitForExplorerNode(api, 'conflict.txt', edgeDir)], transfer);
      await api.explorerProvider.handleDrop(await waitForExplorerNode(api, 'destination', edgeDir), transfer);
    });
    assert.ok(fs.existsSync(conflictSource.fsPath), 'Skipping conflict should keep the source file.');
    assert.strictEqual(fs.readFileSync(conflictDest.fsPath, 'utf8'), 'destination version\n');

    await withWarningMessage('Overwrite', async () => {
      const transfer = new vscode.DataTransfer();
      api.explorerProvider.handleDrag([await waitForExplorerNode(api, 'conflict.txt', edgeDir)], transfer);
      await api.explorerProvider.handleDrop(await waitForExplorerNode(api, 'destination', edgeDir), transfer);
    });
    await waitFor(() => !fs.existsSync(conflictSource.fsPath), 'overwrite move to remove source');
    assert.strictEqual(fs.readFileSync(conflictDest.fsPath, 'utf8'), 'source version\n');

    const parent = uri('explorer-edge/parent');
    const child = uri('explorer-edge/parent/child');
    fs.mkdirSync(child.fsPath, { recursive: true });
    api.explorerProvider.refresh();
    const parentNode = await waitForExplorerNode(api, 'parent', edgeDir);
    const childNode = await waitForExplorerNode(api, 'child', parent);
    const transfer = new vscode.DataTransfer();
    api.explorerProvider.handleDrag([parentNode], transfer);
    await api.explorerProvider.handleDrop(childNode, transfer);
    assert.ok(fs.existsSync(parent.fsPath), 'Dragging a folder into itself should be ignored.');
    assert.ok(!fs.existsSync(path.join(child.fsPath, 'parent')));
  });

  test('pastes files placed on the OS clipboard by another application', async function () {
    this.timeout(20_000);
    const { writeClipboardFileUris, readClipboardFileUris } = await import('../../osClipboard.js');

    const base = uri('os-clip');
    fs.mkdirSync(base.fsPath, { recursive: true });
    const probe = uri('os-clip/probe.txt');
    const probeFolder = uri('os-clip/probe-folder');
    const probeNested = uri('os-clip/probe-folder/nested.txt');
    fs.mkdirSync(probeFolder.fsPath, { recursive: true });
    fs.writeFileSync(probe.fsPath, 'probe\n');
    fs.writeFileSync(probeNested.fsPath, 'probe nested\n');

    // The native OS clipboard is unavailable in some headless environments; the
    // feature degrades gracefully there, so skip rather than fail.
    const wrote = await writeClipboardFileUris([probe, probeFolder]);
    const readBack = await readClipboardFileUris();
    if (
      !wrote ||
      !readBack.some((u) => path.basename(u.fsPath) === 'probe.txt') ||
      !readBack.some((u) => path.basename(u.fsPath) === 'probe-folder')
    ) {
      this.skip();
      return;
    }

    // An internal copy is on the clipboard, but a newer external selection —
    // simulating a copy from Finder / Explorer / another window — must win.
    const internal = uri('os-clip/internal.txt');
    fs.writeFileSync(internal.fsPath, 'internal\n');
    const external = uri('os-clip/external.txt');
    const externalFolder = uri('os-clip/external-folder');
    const externalNested = uri('os-clip/external-folder/nested.txt');
    fs.writeFileSync(external.fsPath, 'from another app\n');
    fs.mkdirSync(externalFolder.fsPath, { recursive: true });
    fs.writeFileSync(externalNested.fsPath, 'external nested\n');
    const targetDir = uri('os-clip/target');
    fs.mkdirSync(targetDir.fsPath, { recursive: true });
    api.explorerProvider.refresh();

    await vscode.commands.executeCommand('tabManager.explorer.copy', itemFor(internal));
    await writeClipboardFileUris([external, externalFolder]);

    const targetNode = await waitForExplorerNode(api, 'target', base);
    await vscode.commands.executeCommand('tabManager.explorer.paste', targetNode);

    const pasted = path.join(targetDir.fsPath, 'external.txt');
    await waitFor(() => fs.existsSync(pasted), 'external OS clipboard paste');
    assert.strictEqual(fs.readFileSync(pasted, 'utf8'), 'from another app\n');
    assert.strictEqual(
      fs.readFileSync(path.join(targetDir.fsPath, 'external-folder/nested.txt'), 'utf8'),
      'external nested\n',
    );
    assert.ok(
      !fs.existsSync(path.join(targetDir.fsPath, 'internal.txt')),
      'A newer external selection should supersede the internal clipboard.',
    );
  });

  test('turns delegated VS Code command failures into handled Explorer errors', async function () {
    this.timeout(30_000);
    const alpha = itemFor(uri('alpha.ts'));
    const notes = itemFor(uri('notes.md'));
    const folder = itemFor(uri('folder'));
    const failingCommands = new Set([
      'revealFileInOS',
      'explorer.openWith',
      'workbench.action.findInFiles',
      'vscode.diff',
    ]);

    await withCommandStub(async (original, command, ...args) => {
      if (failingCommands.has(command)) throw new Error(`${command} failed`);
      return original(command, ...args);
    }, async (execute) => {
      await withErrorMessage(undefined, async () => {
        await expectNoCommandFailure('revealInOS delegated failure', () =>
          execute('tabManager.explorer.revealInOS', alpha),
        );
        await expectNoCommandFailure('openWith delegated failure', () =>
          execute('tabManager.explorer.openWith', alpha),
        );
        await expectNoCommandFailure('findInFolder delegated failure', () =>
          execute('tabManager.explorer.findInFolder', folder),
        );
        await execute('tabManager.explorer.selectForCompare', alpha);
        await expectNoCommandFailure('compareWithSelected delegated failure', () =>
          execute('tabManager.explorer.compareWithSelected', notes),
        );
        await expectNoCommandFailure('compareSelected delegated failure', () =>
          execute('tabManager.explorer.compareSelected', undefined, [alpha, notes]),
        );
      });
    });

    await withObjectStub(vscode.window, 'createTerminal', () => {
      throw new Error('terminal failed');
    }, async () => {
      await withErrorMessage(undefined, () =>
        expectNoCommandFailure('openInTerminal delegated failure', () =>
          vscode.commands.executeCommand('tabManager.explorer.openInTerminal', folder),
        ),
      );
    });
  });

  test('does not fail when external drop data cannot be read', async function () {
    this.timeout(30_000);
    const folderNode = await waitForExplorerNode(api, 'folder');
    const failingDrop = {
      get(mime: string) {
        if (mime !== 'text/uri-list') return undefined;
        return {
          asString: async () => {
            throw new Error('drop data failed');
          },
        };
      },
    } as unknown as vscode.DataTransfer;

    await withErrorMessage(undefined, () =>
      expectNoCommandFailure('unreadable external drop', () =>
        api.explorerProvider.handleDrop(folderNode, failingDrop),
      ),
    );
  });

  test('keeps workspace state actions usable when persistence fails', async () => {
    const failingStore = new GroupStore(failingStorageContext());

    await withWarningMessage(undefined, async () => {
      let created: UserGroup | undefined;
      await expectNoCommandFailure('create group with failing persistence', async () => {
        created = await failingStore.createGroup('Volatile');
      });
      assert.ok(created, 'Expected group creation to still update in-memory state.');

      await expectNoCommandFailure('rename group with failing persistence', () =>
        failingStore.renameGroup(created!.id, 'Renamed Volatile'),
      );
      assert.deepStrictEqual(
        failingStore.getGroups().map((group) => group.name),
        ['Renamed Volatile'],
      );

      await expectNoCommandFailure('add tabs with failing persistence', () =>
        failingStore.addTabsToGroup(created!.id, ['tab-a', 'tab-b']),
      );
      assert.deepStrictEqual(failingStore.getGroups()[0].tabKeys, ['tab-a', 'tab-b']);

      await expectNoCommandFailure('sort with failing persistence', () =>
        failingStore.setNameSort('asc'),
      );
      assert.strictEqual(failingStore.getSortState().name, 'asc');

      await expectNoCommandFailure('filter with failing persistence', () =>
        failingStore.setFilterMode('tabsOnly'),
      );
      assert.strictEqual(failingStore.getFilterMode(), 'tabsOnly');

      await expectNoCommandFailure('layout with failing persistence', () =>
        failingStore.setTabLayoutMode('merged'),
      );
      assert.strictEqual(failingStore.getTabLayoutMode(), 'merged');
    });
  });

  test('handles multi-root workspace roots', async function () {
    this.timeout(60_000);
    const secondRootPath = fs.mkdtempSync(path.join(path.dirname(workspaceRoot), 'tab-manager-e2e-second-root-'));
    const secondFile = vscode.Uri.file(path.join(secondRootPath, 'second-root-file.txt'));
    fs.writeFileSync(secondFile.fsPath, 'second root\n');

    const originalFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    try {
      const added = vscode.workspace.updateWorkspaceFolders(originalFolderCount, 0, {
        uri: vscode.Uri.file(secondRootPath),
        name: 'Second Root',
      });
      assert.strictEqual(added, true);
      await waitFor(
        () => (vscode.workspace.workspaceFolders?.length ?? 0) === originalFolderCount + 1,
        'second workspace folder to be added',
      );

      const roots = await explorerRoots(api);
      assert.ok(roots.some((node) => label(node) === path.basename(workspaceRoot)));
      assert.ok(roots.some((node) => label(node) === 'Second Root'));

      const secondRootNode = await waitForExplorerNode(api, 'Second Root');
      const secondRootChildren = await explorerChildren(api, secondRootNode);
      assert.ok(secondRootChildren.some((node) => label(node) === 'second-root-file.txt'));

      await vscode.commands.executeCommand('tabManager.explorer.open', secondFile);
      await waitFor(() => activeUri()?.toString() === secondFile.toString(), 'multi-root file to open');
    } finally {
      await closeAllEditors();
      const folders = vscode.workspace.workspaceFolders ?? [];
      const index = folders.findIndex(
        (folder) => folder.uri.fsPath === secondRootPath || folder.name === 'Second Root',
      );
      if (index !== -1) vscode.workspace.updateWorkspaceFolders(index, 1);
      fs.rmSync(secondRootPath, { recursive: true, force: true });
    }
  });
});

async function activateExtension(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension('newdlops.tab-manager');
  assert.ok(extension, 'Expected newdlops.tab-manager extension to be installed in test host.');
  return (await extension.activate()) as TestApi;
}

async function resetState(api: TestApi): Promise<void> {
  await vscode.commands.executeCommand('tabManager.filter.clear');
  await vscode.commands.executeCommand('tabManager.layout.merged');

  const sort = api.store.getSortState();
  if (sort.name !== 'none') await vscode.commands.executeCommand('tabManager.sort.nameNone');
  if (sort.type) await vscode.commands.executeCommand('tabManager.sort.toggleType');
  if (sort.readOnly) await vscode.commands.executeCommand('tabManager.sort.toggleReadOnly');

  const explorerDisplay = api.store.getExplorerDisplayOptions();
  if (explorerDisplay.fileSize) {
    await vscode.commands.executeCommand('tabManager.explorer.toggleFileSize');
  }
  if (explorerDisplay.lineCount) {
    await vscode.commands.executeCommand('tabManager.explorer.toggleLineCount');
  }

  for (const group of [...api.store.getGroups()]) {
    await api.store.deleteGroup(group.id);
  }
  api.tabProvider.refresh();
  api.explorerProvider.refresh();
  await api.filterSource.refresh();
}

function uri(relativePath: string): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceRoot, relativePath));
}

function git(args: string[]): void {
  childProcess.execFileSync('git', args, {
    cwd: workspaceRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Tab Manager E2E',
      GIT_AUTHOR_EMAIL: 'tab-manager-e2e@example.com',
      GIT_COMMITTER_NAME: 'Tab Manager E2E',
      GIT_COMMITTER_EMAIL: 'tab-manager-e2e@example.com',
    },
  });
}

async function openFile(
  target: vscode.Uri,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.One,
): Promise<vscode.Tab> {
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, { viewColumn, preview: false });
  return waitFor(() => tabForUri(target), `${path.basename(target.fsPath)} tab to open`);
}

async function editOpenDocument(target: vscode.Uri, text: string): Promise<void> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), text));
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(100);
}

async function tabRoots(api: TestApi): Promise<unknown[]> {
  api.tabProvider.refresh();
  await sleep(80);
  return [...(await api.tabProvider.getChildren(undefined))];
}

async function tabChildren(api: TestApi, node: unknown): Promise<unknown[]> {
  return [...(await api.tabProvider.getChildren(node))];
}

async function explorerRoots(api: TestApi): Promise<unknown[]> {
  api.explorerProvider.refresh();
  await sleep(100);
  return [...(await api.explorerProvider.getChildren(undefined))];
}

async function explorerChildren(api: TestApi, node: unknown): Promise<unknown[]> {
  await sleep(80);
  return [...(await api.explorerProvider.getChildren(node))];
}

async function explorerNode(api: TestApi, wanted: string): Promise<unknown | undefined> {
  return (await explorerRoots(api)).find((node) => label(node) === wanted);
}

async function waitForExplorerNode(
  api: TestApi,
  wanted: string,
  parent?: vscode.Uri,
): Promise<unknown> {
  return waitFor(async () => {
    const nodes = parent ? await explorerChildrenForUri(api, parent) : await explorerRoots(api);
    return nodes.find((node) => label(node) === wanted);
  }, `Explorer node ${wanted}`);
}

async function explorerChildrenForUri(api: TestApi, parent: vscode.Uri): Promise<unknown[]> {
  if (parent.fsPath === workspaceRoot) return explorerRoots(api);
  const node = await explorerNodeForUri(api, parent);
  return node ? explorerChildren(api, node) : [];
}

async function explorerNodeForUri(api: TestApi, target: vscode.Uri): Promise<unknown | undefined> {
  const relative = path.relative(workspaceRoot, target.fsPath);
  if (!relative || relative.startsWith('..')) return undefined;

  let children = await explorerRoots(api);
  let current: unknown | undefined;
  for (const part of relative.split(path.sep)) {
    current = children.find((node) => label(node) === part);
    if (!current) return undefined;
    children = await explorerChildren(api, current);
  }
  return current;
}

function labels(nodes: readonly unknown[]): string[] {
  return nodes.map(label);
}

function baseName(target: vscode.Uri): string {
  return path.basename(target.fsPath);
}

function label(node: unknown): string {
  const value = (node as { label?: unknown }).label;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'label' in value) {
    return String((value as { label: unknown }).label);
  }
  return '';
}

function description(node: unknown): string {
  const value = (node as { description?: unknown }).description;
  return typeof value === 'string' ? value : '';
}

function strikeLabel(value: string): string {
  return Array.from(value, (character) => `${character}\u0336`).join('');
}

function itemFor(target: vscode.Uri): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(target.fsPath));
  item.resourceUri = target;
  return item;
}

function activeUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri;
}

function activeTabLabel(): string {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '';
}

function activeTabUri(): vscode.Uri | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return activeTab ? tabUri(activeTab) : undefined;
}

function hasOpenTab(target: vscode.Uri): boolean {
  return !!tabForUri(target);
}

function tabForUri(target: vscode.Uri): vscode.Tab | undefined {
  const wanted = target.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tabUri(tab)?.toString() === wanted) return tab;
    }
  }
  return undefined;
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  if (input instanceof vscode.TabInputNotebookDiff) return input.modified;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

async function withInputBox<T>(value: string, run: () => Thenable<T>): Promise<T> {
  return withWindowStub('showInputBox', async () => value, run);
}

async function withQuickPick<T>(
  choose: (items: Array<{ label: string }>) => unknown,
  run: () => Thenable<T>,
): Promise<T> {
  return withWindowStub(
    'showQuickPick',
    async (items: readonly unknown[] | Thenable<readonly unknown[]>) => {
      const resolved = [...(await Promise.resolve(items))] as Array<{ label: string }>;
      return choose(resolved);
    },
    run,
  );
}

async function withWarningMessage<T>(value: string | undefined, run: () => Thenable<T>): Promise<T> {
  return withWindowStub('showWarningMessage', async () => value, run);
}

async function withErrorMessage<T>(value: string | undefined, run: () => Thenable<T>): Promise<T> {
  return withWindowStub('showErrorMessage', async () => value, run);
}

async function withCreateInputBox<T>(value: string, run: () => Thenable<T>): Promise<T> {
  let input: FakeInputBox | undefined;
  return withWindowStub('createInputBox', () => {
    input = new FakeInputBox(value);
    return input as unknown as vscode.InputBox;
  }, async () => {
    const result = await run();
    await sleep(100);
    input?.hide();
    return result;
  });
}

type ExecuteCommand = typeof vscode.commands.executeCommand;

async function withCommandStub<T>(
  handler: (
    original: ExecuteCommand,
    command: string,
    ...args: unknown[]
  ) => unknown | Thenable<unknown>,
  run: (execute: ExecuteCommand) => Thenable<T>,
): Promise<T> {
  const original = vscode.commands.executeCommand.bind(vscode.commands) as ExecuteCommand;
  const replacement = ((command: string, ...args: unknown[]) =>
    handler(original, command, ...args)) as ExecuteCommand;
  return withObjectStub(vscode.commands, 'executeCommand', replacement, () => run(original));
}

async function withWindowStub<T>(
  key: keyof typeof vscode.window,
  value: unknown,
  run: () => Thenable<T>,
): Promise<T> {
  return withObjectStub(vscode.window, key, value, run);
}

async function withObjectStub<TTarget extends object, T>(
  target: TTarget,
  key: keyof TTarget,
  value: unknown,
  run: () => Thenable<T>,
): Promise<T> {
  const record = target as unknown as Record<string, unknown>;
  const property = key as string;
  const original = record[property];
  Object.defineProperty(record, property, {
    configurable: true,
    writable: true,
    value,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(record, property, {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

class FakeInputBox {
  value = '';
  title: string | undefined;
  placeholder: string | undefined;
  prompt: string | undefined;
  validationMessage: string | undefined;
  valueSelection: [number, number] | undefined;
  password = false;
  ignoreFocusOut = false;
  enabled = true;
  busy = false;
  buttons: readonly vscode.QuickInputButton[] = [];
  step: number | undefined;
  totalSteps: number | undefined;

  private readonly acceptEmitter = new vscode.EventEmitter<void>();
  private readonly changeEmitter = new vscode.EventEmitter<string>();
  private readonly hideEmitter = new vscode.EventEmitter<void>();
  private readonly buttonEmitter = new vscode.EventEmitter<vscode.QuickInputButton>();
  private hidden = false;
  get isHidden(): boolean {
    return this.hidden;
  }
  readonly onDidAccept = this.acceptEmitter.event;
  readonly onDidChangeValue = this.changeEmitter.event;
  readonly onDidHide = this.hideEmitter.event;
  readonly onDidTriggerButton = this.buttonEmitter.event;

  constructor(private readonly acceptedValue: string) {}

  show(): void {
    setTimeout(() => {
      this.value = this.acceptedValue;
      this.changeEmitter.fire(this.value);
      this.acceptEmitter.fire();
    }, 0);
  }

  hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.hideEmitter.fire();
  }

  dispose(): void {
    this.acceptEmitter.dispose();
    this.changeEmitter.dispose();
    this.hideEmitter.dispose();
    this.buttonEmitter.dispose();
  }
}

function failingStorageContext(): vscode.ExtensionContext {
  const workspaceState = {
    get<T>(_key: string, defaultValue?: T): T | undefined {
      return defaultValue;
    },
    update(_key: string, _value: unknown): Thenable<void> {
      return Promise.reject(new Error('workspace state failed'));
    },
    keys(): readonly string[] {
      return [];
    },
  };
  return { workspaceState } as unknown as vscode.ExtensionContext;
}

async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  descriptionText: string,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  let lastValue: T | undefined | false;
  while (Date.now() - start < timeoutMs) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${descriptionText}. Last value: ${String(lastValue)}`);
}

async function expectNoCommandFailure(
  descriptionText: string,
  run: () => Thenable<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`${descriptionText} rejected: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
