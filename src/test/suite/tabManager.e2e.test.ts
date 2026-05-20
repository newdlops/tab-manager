import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GroupStore } from '../../groupStore';

type FilterMode =
  | 'none'
  | 'modified'
  | 'untracked'
  | 'deleted'
  | 'errors'
  | 'tabsOnly'
  | 'unsaved'
  | 'readOnly';

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

interface TestApi {
  context: vscode.ExtensionContext;
  store: {
    getGroups(): UserGroup[];
    deleteGroup(id: string): Promise<void>;
    getSortState(): SortState;
    getFilterMode(): FilterMode;
    getTabLayoutMode(): 'byColumn' | 'merged';
  };
  tabProvider: {
    refresh(): void;
    getChildren(element?: unknown): unknown[] | Thenable<unknown[]>;
  };
  explorerProvider: {
    refresh(): void;
    getChildren(element?: unknown): unknown[] | Thenable<unknown[]>;
    handleDrag(source: readonly unknown[], dataTransfer: vscode.DataTransfer): void;
    handleDrop(target: unknown, dataTransfer: vscode.DataTransfer): Promise<void>;
  };
  filterSource: {
    refresh(): Promise<void>;
    getUris(mode: FilterMode): vscode.Uri[];
    matches(uri: vscode.Uri, mode: FilterMode): boolean;
    isReadOnly(uri: vscode.Uri): boolean;
    isMissing(uri: vscode.Uri): boolean;
  };
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
    assert.deepStrictEqual(new Set(labels(await tabRoots(api))), new Set(['Column 1', 'Column 2']));

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

  test('recovers from persisted state after reload and ignores corrupted state', async function () {
    this.timeout(30_000);
    await withInputBox('Persisted Group', () =>
      vscode.commands.executeCommand('tabManager.createGroup'),
    );
    await vscode.commands.executeCommand('tabManager.sort.nameDesc');
    await vscode.commands.executeCommand('tabManager.sort.toggleType');
    await vscode.commands.executeCommand('tabManager.filter.tabsOnly');
    await vscode.commands.executeCommand('tabManager.layout.byColumn');

    let reloaded = new GroupStore(api.context);
    assert.deepStrictEqual(
      reloaded.getGroups().map((group) => group.name),
      ['Persisted Group'],
    );
    assert.deepStrictEqual(reloaded.getSortState(), { name: 'desc', type: true, readOnly: false });
    assert.strictEqual(reloaded.getFilterMode(), 'tabsOnly');
    assert.strictEqual(reloaded.getTabLayoutMode(), 'byColumn');

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

    reloaded = new GroupStore(api.context);
    assert.deepStrictEqual(reloaded.getGroups(), [
      { id: 'valid', name: 'Recovered', tabKeys: ['text::one'] },
    ]);
    assert.deepStrictEqual(reloaded.getSortState(), { name: 'none', type: false, readOnly: false });
    assert.strictEqual(reloaded.getFilterMode(), 'none');
    assert.strictEqual(reloaded.getTabLayoutMode(), 'byColumn');
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
      deletedRoots.some((node) => label(node) === 'delete-me.txt' && description(node) === 'deleted'),
      'Expected deleted files to appear as ghost entries in the explorer.',
    );
  });

  test('covers explorer file commands, clipboard commands, compare, terminal, and drag-drop', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('tabManager.filter.clear');

    const initial = labels(await explorerRoots(api));
    assert.ok(initial.includes('alpha.ts'));
    assert.ok(initial.includes('folder'));

    const alpha = uri('alpha.ts');
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
