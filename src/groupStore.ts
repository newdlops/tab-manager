import * as vscode from 'vscode';

export type NameSort = 'none' | 'asc' | 'desc';

export interface SortState {
  name: NameSort;
  type: boolean;
  readOnly: boolean;
}

export type TabLayoutMode = 'byColumn' | 'merged';

export type FilterMode =
  | 'none'
  | 'modified'
  | 'untracked'
  | 'deleted'
  | 'errors'
  | 'tabsOnly'
  | 'unsaved'
  | 'readOnly';

export interface UserGroup {
  id: string;
  name: string;
  tabKeys: string[];
}

const GROUPS_KEY = 'tabManager.groups';
const SORT_KEY = 'tabManager.sortState';
const FILTER_KEY = 'tabManager.filterMode';
const TAB_LAYOUT_KEY = 'tabManager.tabLayoutMode';

const DEFAULT_SORT: SortState = { name: 'none', type: false, readOnly: false };
const DEFAULT_TAB_LAYOUT: TabLayoutMode = 'byColumn';
const FILTER_MODES: readonly FilterMode[] = [
  'none',
  'modified',
  'untracked',
  'deleted',
  'errors',
  'tabsOnly',
  'unsaved',
  'readOnly',
];

export class GroupStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private cachedGroups?: UserGroup[];
  private cachedTabKeyToGroup?: Map<string, UserGroup>;
  private cachedSortState?: SortState;
  private cachedFilterMode?: FilterMode;
  private cachedTabLayoutMode?: TabLayoutMode;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getGroups(): UserGroup[] {
    if (!this.cachedGroups) {
      this.cachedGroups = this.context.workspaceState.get<UserGroup[]>(GROUPS_KEY) ?? [];
    }
    return this.cachedGroups;
  }

  getTabKeyToGroup(): Map<string, UserGroup> {
    if (!this.cachedTabKeyToGroup) {
      const map = new Map<string, UserGroup>();
      for (const g of this.getGroups()) {
        for (const k of g.tabKeys) map.set(k, g);
      }
      this.cachedTabKeyToGroup = map;
    }
    return this.cachedTabKeyToGroup;
  }

  private async setGroups(groups: UserGroup[]): Promise<void> {
    this.cachedGroups = groups;
    this.cachedTabKeyToGroup = undefined;
    await this.context.workspaceState.update(GROUPS_KEY, groups);
    this._onDidChange.fire();
  }

  async createGroup(name: string): Promise<UserGroup> {
    const group: UserGroup = {
      id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      tabKeys: [],
    };
    await this.setGroups([...this.getGroups(), group]);
    return group;
  }

  async renameGroup(id: string, name: string): Promise<void> {
    await this.setGroups(this.getGroups().map((g) => (g.id === id ? { ...g, name } : g)));
  }

  async deleteGroup(id: string): Promise<void> {
    await this.setGroups(this.getGroups().filter((g) => g.id !== id));
  }

  async addTabToGroup(groupId: string, tabKey: string): Promise<void> {
    await this.addTabsToGroup(groupId, [tabKey]);
  }

  async addTabsToGroup(groupId: string, tabKeys: readonly string[]): Promise<void> {
    const uniqueKeys = [...new Set(tabKeys)];
    if (uniqueKeys.length === 0) return;
    const keySet = new Set(uniqueKeys);
    let foundTarget = false;
    let changed = false;
    const next = this.getGroups().map((g) => {
      if (g.id === groupId) {
        foundTarget = true;
        const existing = new Set(g.tabKeys);
        let targetChanged = false;
        for (const key of uniqueKeys) {
          if (!existing.has(key)) {
            existing.add(key);
            targetChanged = true;
            changed = true;
          }
        }
        return targetChanged ? { ...g, tabKeys: [...existing] } : g;
      }
      const filtered = g.tabKeys.filter((k) => !keySet.has(k));
      if (filtered.length !== g.tabKeys.length) {
        changed = true;
        return { ...g, tabKeys: filtered };
      }
      return g;
    });
    if (!foundTarget || !changed) return;
    await this.setGroups(next);
  }

  async removeTabFromGroup(tabKey: string): Promise<void> {
    await this.removeTabsFromGroups([tabKey]);
  }

  async removeTabsFromGroups(tabKeys: readonly string[]): Promise<void> {
    const keySet = new Set(tabKeys);
    if (keySet.size === 0) return;
    let changed = false;
    const next = this.getGroups().map((g) => {
      const filtered = g.tabKeys.filter((k) => !keySet.has(k));
      if (filtered.length === g.tabKeys.length) return g;
      changed = true;
      return { ...g, tabKeys: filtered };
    });
    if (!changed) return;
    await this.setGroups(next);
  }

  findGroupForTab(tabKey: string): UserGroup | undefined {
    return this.getTabKeyToGroup().get(tabKey);
  }

  getSortState(): SortState {
    if (this.cachedSortState) return this.cachedSortState;
    const raw = this.context.workspaceState.get<unknown>(SORT_KEY);
    if (
      raw &&
      typeof raw === 'object' &&
      'name' in raw &&
      'type' in raw &&
      typeof (raw as SortState).type === 'boolean'
    ) {
      const partial = raw as Partial<SortState> & { name: NameSort; type: boolean };
      this.cachedSortState = { readOnly: false, ...partial };
      return this.cachedSortState;
    }
    this.cachedSortState = DEFAULT_SORT;
    return DEFAULT_SORT;
  }

  async setNameSort(name: NameSort): Promise<void> {
    const state = this.getSortState();
    if (state.name === name) return;
    this.cachedSortState = { ...state, name };
    await this.context.workspaceState.update(SORT_KEY, this.cachedSortState);
    this._onDidChange.fire();
  }

  async toggleTypeSort(): Promise<void> {
    const state = this.getSortState();
    this.cachedSortState = { ...state, type: !state.type };
    await this.context.workspaceState.update(SORT_KEY, this.cachedSortState);
    this._onDidChange.fire();
  }

  async toggleReadOnlySort(): Promise<void> {
    const state = this.getSortState();
    this.cachedSortState = { ...state, readOnly: !state.readOnly };
    await this.context.workspaceState.update(SORT_KEY, this.cachedSortState);
    this._onDidChange.fire();
  }

  getFilterMode(): FilterMode {
    if (this.cachedFilterMode) return this.cachedFilterMode;
    const raw = this.context.workspaceState.get<FilterMode>(FILTER_KEY);
    this.cachedFilterMode = raw && FILTER_MODES.includes(raw) ? raw : 'none';
    return this.cachedFilterMode;
  }

  async setFilterMode(mode: FilterMode): Promise<void> {
    if (this.getFilterMode() === mode) return;
    this.cachedFilterMode = mode;
    await this.context.workspaceState.update(FILTER_KEY, mode);
    this._onDidChange.fire();
  }

  async toggleFilterMode(mode: Exclude<FilterMode, 'none'>): Promise<void> {
    const current = this.getFilterMode();
    await this.setFilterMode(current === mode ? 'none' : mode);
  }

  getTabLayoutMode(): TabLayoutMode {
    if (this.cachedTabLayoutMode) return this.cachedTabLayoutMode;
    const raw = this.context.workspaceState.get<TabLayoutMode>(TAB_LAYOUT_KEY);
    this.cachedTabLayoutMode = raw === 'merged' || raw === 'byColumn' ? raw : DEFAULT_TAB_LAYOUT;
    return this.cachedTabLayoutMode;
  }

  async setTabLayoutMode(mode: TabLayoutMode): Promise<void> {
    if (this.getTabLayoutMode() === mode) return;
    this.cachedTabLayoutMode = mode;
    await this.context.workspaceState.update(TAB_LAYOUT_KEY, mode);
    this._onDidChange.fire();
  }
}
