import * as vscode from 'vscode';
import type { FilterMode, GroupStore, UserGroup } from './groupStore';
import type { FilterSource } from './filterSource';
import {
  columnLabel,
  resourceUriFor,
  sortTabs,
  tabColumnKey,
  tabColumnLabel,
  tabKey,
  tabTypeCategory,
  type TabTypeCategory,
} from './tabUtils';
import { debounce } from './util';

export type TabTreeNode = ColumnNode | GroupNode | UngroupedHeaderNode | TabNode;

export class ColumnNode extends vscode.TreeItem {
  constructor(
    public readonly columnKey: string,
    label: string,
    tabCount: number,
    active = false,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `column:${columnKey}`;
    this.description = active ? `${tabCount} · active` : `${tabCount}`;
    this.contextValue = 'tabColumn';
    this.iconPath = new vscode.ThemeIcon('split-horizontal');
  }
}

export class GroupNode extends vscode.TreeItem {
  constructor(
    public readonly group: UserGroup,
    tabCount: number,
    public readonly columnKey?: string,
  ) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = columnKey ? `group:${columnKey}:${group.id}` : `group:${group.id}`;
    this.description = `${tabCount}`;
    this.contextValue = 'tabGroup';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export class UngroupedHeaderNode extends vscode.TreeItem {
  constructor(
    tabCount: number,
    public readonly columnKey?: string,
  ) {
    super('Ungrouped', vscode.TreeItemCollapsibleState.Expanded);
    this.id = columnKey ? `ungrouped:${columnKey}` : 'ungrouped';
    this.description = `${tabCount}`;
    this.contextValue = 'ungroupedHeader';
    this.iconPath = new vscode.ThemeIcon('list-unordered');
  }
}

export class TabNode extends vscode.TreeItem {
  public readonly key: string;

  constructor(
    public readonly tab: vscode.Tab,
    public readonly inGroup: boolean,
    isReadOnly = false,
    showColumn = false,
  ) {
    super(tab.label, vscode.TreeItemCollapsibleState.None);
    this.key = tabKey(tab);

    const uri = resourceUriFor(tab);
    const base = uri ? 'tab.file' : 'tab';
    this.contextValue = inGroup ? `${base}.grouped` : base;

    const descParts: string[] = [];
    if (uri) {
      this.resourceUri = uri;
      this.iconPath = vscode.ThemeIcon.File;
      descParts.push(vscode.workspace.asRelativePath(uri, false));
      this.tooltip = uri.fsPath;
    } else {
      const category = tabTypeCategory(tab);
      this.iconPath = new vscode.ThemeIcon(iconForType(category));
      descParts.push(category);
      this.tooltip = tab.label;
    }
    if (showColumn) descParts.push(tabColumnLabel(tab));
    if (tab.isPreview) descParts.push('preview');
    if (tab.isDirty) descParts.push('unsaved');
    if (isReadOnly) descParts.push('read-only');
    this.description = descParts.join(' · ');

    this.command = {
      command: 'tabManager.openTab',
      title: 'Open Tab',
      arguments: [this],
    };
  }
}

function iconForType(t: TabTypeCategory): string {
  switch (t) {
    case 'terminal':
      return 'terminal';
    case 'notebook':
      return 'notebook';
    case 'diff':
      return 'diff';
    case 'webview':
      return 'browser';
    case 'custom':
      return 'file-binary';
    default:
      return 'window';
  }
}

export class TabTreeDataProvider implements vscode.TreeDataProvider<TabTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TabTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly fireDebounced = debounce(() => this._onDidChangeTreeData.fire(undefined), 30);
  private cachedTabs?: { mode: FilterMode; tabs: vscode.Tab[] };

  constructor(
    private readonly store: GroupStore,
    private readonly filter: FilterSource,
  ) {
    store.onDidChange(() => this.fireDebounced());
    filter.onDidChange(() => this.invalidateAndFire());
  }

  private invalidateAndFire(): void {
    this.cachedTabs = undefined;
    this.fireDebounced();
  }

  private getFilteredTabs(): vscode.Tab[] {
    const mode = this.store.getFilterMode();
    if (this.cachedTabs?.mode === mode) return this.cachedTabs.tabs;

    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (mode === 'none') {
          tabs.push(tab);
          continue;
        }
        const uri = resourceUriFor(tab);
        if (uri && this.filter.matches(uri, mode)) tabs.push(tab);
      }
    }

    this.cachedTabs = { mode, tabs };
    return tabs;
  }

  refresh(): void {
    this.cachedTabs = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TabTreeNode): vscode.TreeItem {
    return element;
  }

  private isTabReadOnly = (tab: vscode.Tab): boolean => {
    const uri = resourceUriFor(tab);
    return uri ? this.filter.isReadOnly(uri) : false;
  };

  getChildren(element?: TabTreeNode): TabTreeNode[] {
    const allTabs = this.getFilteredTabs();
    const sortMode = this.store.getSortState();
    const layout = this.store.getTabLayoutMode();

    if (!element) {
      if (layout === 'byColumn') return this.getColumnNodes(allTabs);
      return this.getGroupedOrTabNodes(allTabs, undefined, true, sortMode);
    }

    if (element instanceof ColumnNode) {
      return this.getGroupedOrTabNodes(
        this.filterTabsByColumn(allTabs, element.columnKey),
        element.columnKey,
        false,
        sortMode,
      );
    }

    if (element instanceof GroupNode) {
      const wanted = new Set(element.group.tabKeys);
      const tabs = this.filterTabsByColumn(allTabs, element.columnKey).filter((t) =>
        wanted.has(tabKey(t)),
      );
      return sortTabs(tabs, sortMode, this.isTabReadOnly).map(
        (t) => new TabNode(t, true, this.isTabReadOnly(t), !element.columnKey),
      );
    }

    if (element instanceof UngroupedHeaderNode) {
      const tabKeyToGroup = this.store.getTabKeyToGroup();
      const tabs = this.filterTabsByColumn(allTabs, element.columnKey).filter(
        (t) => !tabKeyToGroup.has(tabKey(t)),
      );
      return sortTabs(tabs, sortMode, this.isTabReadOnly).map(
        (t) => new TabNode(t, false, this.isTabReadOnly(t), !element.columnKey),
      );
    }

    return [];
  }

  private getColumnNodes(allTabs: vscode.Tab[]): TabTreeNode[] {
    const counts = new Map<string, number>();
    for (const tab of allTabs) {
      const key = tabColumnKey(tab);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const nodes: TabTreeNode[] = [];
    const seen = new Set<string>();
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    for (const group of vscode.window.tabGroups.all) {
      const key = String(group.viewColumn);
      if (seen.has(key)) continue;
      seen.add(key);
      const count = counts.get(key) ?? 0;
      if (count === 0) continue;
      nodes.push(new ColumnNode(key, columnLabel(group.viewColumn), count, group === activeGroup));
    }
    return nodes;
  }

  private getGroupedOrTabNodes(
    tabs: vscode.Tab[],
    columnKey: string | undefined,
    includeEmptyGroups: boolean,
    sortMode = this.store.getSortState(),
  ): TabTreeNode[] {
    const groups = this.store.getGroups();
    if (groups.length === 0) {
      return sortTabs(tabs, sortMode, this.isTabReadOnly).map(
        (t) => new TabNode(t, false, this.isTabReadOnly(t), !columnKey),
      );
    }

    const tabKeyToGroup = this.store.getTabKeyToGroup();
    const groupCounts = new Map<string, number>();
    let ungroupedCount = 0;
    for (const t of tabs) {
      const g = tabKeyToGroup.get(tabKey(t));
      if (g) groupCounts.set(g.id, (groupCounts.get(g.id) ?? 0) + 1);
      else ungroupedCount++;
    }

    const nodes: TabTreeNode[] = [];
    for (const g of groups) {
      const count = groupCounts.get(g.id) ?? 0;
      if (includeEmptyGroups || count > 0) nodes.push(new GroupNode(g, count, columnKey));
    }
    if (ungroupedCount > 0) nodes.push(new UngroupedHeaderNode(ungroupedCount, columnKey));
    return nodes;
  }

  private filterTabsByColumn(tabs: vscode.Tab[], columnKey: string | undefined): vscode.Tab[] {
    if (!columnKey) return tabs;
    return tabs.filter((t) => tabColumnKey(t) === columnKey);
  }
}
