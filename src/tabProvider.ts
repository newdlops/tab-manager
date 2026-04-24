import * as vscode from 'vscode';
import type { GroupStore, UserGroup } from './groupStore';
import type { FilterSource } from './filterSource';
import {
  resourceUriFor,
  sortTabs,
  tabKey,
  tabTypeCategory,
  type TabTypeCategory,
} from './tabUtils';
import { debounce } from './util';

export type TabTreeNode = GroupNode | UngroupedHeaderNode | TabNode;

export class GroupNode extends vscode.TreeItem {
  constructor(public readonly group: UserGroup, tabCount: number) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `group:${group.id}`;
    this.description = `${tabCount}`;
    this.contextValue = 'tabGroup';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export class UngroupedHeaderNode extends vscode.TreeItem {
  constructor(tabCount: number) {
    super('Ungrouped', vscode.TreeItemCollapsibleState.Expanded);
    this.id = 'ungrouped';
    this.description = `${tabCount}`;
    this.contextValue = 'ungroupedHeader';
    this.iconPath = new vscode.ThemeIcon('list-unordered');
  }
}

export class TabNode extends vscode.TreeItem {
  public readonly key: string;

  constructor(public readonly tab: vscode.Tab, public readonly inGroup: boolean) {
    super(tab.label, vscode.TreeItemCollapsibleState.None);
    this.key = tabKey(tab);
    this.contextValue = inGroup ? 'tab.grouped' : 'tab';

    const uri = resourceUriFor(tab);
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
    if (tab.isPreview) descParts.push('preview');
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

  constructor(
    private readonly store: GroupStore,
    private readonly filter: FilterSource,
  ) {
    store.onDidChange(() => this.fireDebounced());
    filter.onDidChange(() => this.fireDebounced());
  }

  private filterTabs(tabs: vscode.Tab[]): vscode.Tab[] {
    const mode = this.store.getFilterMode();
    if (mode === 'none') return tabs;
    return tabs.filter((t) => {
      const uri = resourceUriFor(t);
      return uri ? this.filter.matches(uri, mode) : false;
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TabTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TabTreeNode): TabTreeNode[] {
    const allTabs = this.filterTabs(vscode.window.tabGroups.all.flatMap((g) => g.tabs));
    const sortMode = this.store.getSortState();
    const groups = this.store.getGroups();

    if (!element) {
      if (groups.length === 0) {
        return sortTabs(allTabs, sortMode).map((t) => new TabNode(t, false));
      }
      const nodes: TabTreeNode[] = groups.map((g) => {
        const tabsInGroup = allTabs.filter((t) => g.tabKeys.includes(tabKey(t)));
        return new GroupNode(g, tabsInGroup.length);
      });
      const ungrouped = allTabs.filter((t) => !this.store.findGroupForTab(tabKey(t)));
      if (ungrouped.length > 0) {
        nodes.push(new UngroupedHeaderNode(ungrouped.length));
      }
      return nodes;
    }

    if (element instanceof GroupNode) {
      const tabs = allTabs.filter((t) => element.group.tabKeys.includes(tabKey(t)));
      return sortTabs(tabs, sortMode).map((t) => new TabNode(t, true));
    }

    if (element instanceof UngroupedHeaderNode) {
      const tabs = allTabs.filter((t) => !this.store.findGroupForTab(tabKey(t)));
      return sortTabs(tabs, sortMode).map((t) => new TabNode(t, false));
    }

    return [];
  }
}
