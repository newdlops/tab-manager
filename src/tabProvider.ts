import * as vscode from 'vscode';
import type { FilterMode, GroupStore, UserGroup } from './groupStore';
import type { FilterSource, FilterSourceChangeEvent } from './filterSource';
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
import { debounce, fileTabContextValue, typedTabContextValue } from './util';

export type TabTreeNode = ColumnNode | GroupNode | UngroupedHeaderNode | TabNode;

function formatTabCount(count: number): string {
  return `${count} ${count === 1 ? 'tab' : 'tabs'}`;
}

function relativeParentPath(uri: vscode.Uri): string | undefined {
  const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  const slash = relative.lastIndexOf('/');
  return slash > 0 ? relative.slice(0, slash) : undefined;
}

export class ColumnNode extends vscode.TreeItem {
  constructor(
    public readonly columnKey: string,
    label: string,
    tabCount: number,
    active = false,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `column:${columnKey}`;
    this.description = active ? `active · ${formatTabCount(tabCount)}` : formatTabCount(tabCount);
    this.contextValue = 'tabColumn';
    this.iconPath = new vscode.ThemeIcon('split-horizontal');
    this.tooltip = [label, active ? 'Active column' : undefined, formatTabCount(tabCount)]
      .filter((part): part is string => !!part)
      .join('\n');
    this.accessibilityInformation = {
      label: [label, active ? 'active column' : undefined, formatTabCount(tabCount)]
        .filter((part): part is string => !!part)
        .join(', '),
      role: 'treeitem',
    };
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
    this.description = formatTabCount(tabCount);
    this.contextValue = 'tabGroup';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = `${group.name}\n${formatTabCount(tabCount)}`;
    this.accessibilityInformation = {
      label: `${group.name}, ${formatTabCount(tabCount)}`,
      role: 'treeitem',
    };
  }
}

export class UngroupedHeaderNode extends vscode.TreeItem {
  constructor(
    tabCount: number,
    public readonly columnKey?: string,
  ) {
    super('Ungrouped', vscode.TreeItemCollapsibleState.Expanded);
    this.id = columnKey ? `ungrouped:${columnKey}` : 'ungrouped';
    this.description = formatTabCount(tabCount);
    this.contextValue = 'ungroupedHeader';
    this.iconPath = new vscode.ThemeIcon('list-unordered');
    this.tooltip = `Ungrouped\n${formatTabCount(tabCount)}`;
    this.accessibilityInformation = {
      label: `Ungrouped, ${formatTabCount(tabCount)}`,
      role: 'treeitem',
    };
  }
}

export class TabNode extends vscode.TreeItem {
  public readonly key: string;

  constructor(
    public readonly tab: vscode.Tab,
    public readonly inGroup: boolean,
    isReadOnly = false,
    showColumn = false,
    isMissing = false,
  ) {
    super(tab.label, vscode.TreeItemCollapsibleState.None);
    this.key = tabKey(tab);

    const uri = resourceUriFor(tab);
    const category = tabTypeCategory(tab);
    this.contextValue = uri
      ? fileTabContextValue(uri.path, { grouped: inGroup })
      : typedTabContextValue(category, { grouped: inGroup });

    const statusParts: string[] = [];
    if (tab.isActive) statusParts.push('active');
    if (tab.isDirty) statusParts.push('unsaved');
    if (isReadOnly) statusParts.push('read-only');
    if (isMissing) statusParts.push('missing');
    if (tab.isPreview) statusParts.push('preview');
    if (showColumn) statusParts.push(tabColumnLabel(tab));

    const descriptionParts = [...statusParts];
    if (uri) {
      this.resourceUri = uri;
      this.iconPath = vscode.ThemeIcon.File;
      const parentPath = relativeParentPath(uri);
      if (parentPath) descriptionParts.push(parentPath);
    } else {
      this.iconPath = new vscode.ThemeIcon(iconForType(category));
      descriptionParts.push(category);
    }
    this.description = descriptionParts.join(' · ') || undefined;

    const tooltipParts = [
      uri ? uri.fsPath : tab.label,
      statusParts.length > 0 ? `Status: ${statusParts.join(', ')}` : undefined,
      'Open Tab',
    ];
    this.tooltip = tooltipParts.filter((part): part is string => !!part).join('\n');

    const accessibilityParts = [
      tab.label,
      uri?.fsPath,
      showColumn ? tabColumnLabel(tab) : undefined,
      tab.isActive ? 'active tab' : undefined,
      tab.isDirty ? 'unsaved' : undefined,
      isReadOnly ? 'read-only' : undefined,
      isMissing ? 'file missing' : undefined,
      tab.isPreview ? 'preview' : undefined,
      uri ? undefined : category,
      'Open Tab',
    ];
    this.accessibilityInformation = {
      label: accessibilityParts.filter((part): part is string => !!part).join(', '),
      role: 'treeitem',
    };

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
    filter.onDidChange((event) => this.handleFilterChange(event));
  }

  private handleFilterChange(event: FilterSourceChangeEvent): void {
    const mode = this.store.getFilterMode();
    const filterModeAffected = mode !== 'none' && event.modes.includes(mode);
    const readOnlySortAffected =
      this.store.getSortState().readOnly && event.modes.includes('readOnly');
    if (filterModeAffected || readOnlySortAffected || event.affectsOpenTabMetadata) {
      this.invalidateAndFire();
    }
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

  private isTabMissing = (tab: vscode.Tab): boolean => {
    const uri = resourceUriFor(tab);
    return uri ? this.filter.isMissing(uri) : false;
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
        (t) =>
          new TabNode(
            t,
            true,
            this.isTabReadOnly(t),
            !element.columnKey,
            this.isTabMissing(t),
          ),
      );
    }

    if (element instanceof UngroupedHeaderNode) {
      const tabKeyToGroup = this.store.getTabKeyToGroup();
      const tabs = this.filterTabsByColumn(allTabs, element.columnKey).filter(
        (t) => !tabKeyToGroup.has(tabKey(t)),
      );
      return sortTabs(tabs, sortMode, this.isTabReadOnly).map(
        (t) =>
          new TabNode(
            t,
            false,
            this.isTabReadOnly(t),
            !element.columnKey,
            this.isTabMissing(t),
          ),
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
        (t) =>
          new TabNode(t, false, this.isTabReadOnly(t), !columnKey, this.isTabMissing(t)),
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
