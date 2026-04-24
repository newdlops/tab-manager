import * as vscode from 'vscode';

export type NameSort = 'none' | 'asc' | 'desc';

export interface SortState {
  name: NameSort;
  type: boolean;
}

export type FilterMode = 'none' | 'modified' | 'untracked' | 'deleted' | 'errors' | 'tabsOnly';

export interface UserGroup {
  id: string;
  name: string;
  tabKeys: string[];
}

const GROUPS_KEY = 'tabManager.groups';
const SORT_KEY = 'tabManager.sortState';
const FILTER_KEY = 'tabManager.filterMode';

const DEFAULT_SORT: SortState = { name: 'none', type: false };
const FILTER_MODES: readonly FilterMode[] = [
  'none',
  'modified',
  'untracked',
  'deleted',
  'errors',
  'tabsOnly',
];

export class GroupStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getGroups(): UserGroup[] {
    return this.context.workspaceState.get<UserGroup[]>(GROUPS_KEY) ?? [];
  }

  private async setGroups(groups: UserGroup[]): Promise<void> {
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
    const next = this.getGroups().map((g) => {
      if (g.id === groupId) {
        return g.tabKeys.includes(tabKey) ? g : { ...g, tabKeys: [...g.tabKeys, tabKey] };
      }
      return { ...g, tabKeys: g.tabKeys.filter((k) => k !== tabKey) };
    });
    await this.setGroups(next);
  }

  async removeTabFromGroup(tabKey: string): Promise<void> {
    await this.setGroups(
      this.getGroups().map((g) => ({ ...g, tabKeys: g.tabKeys.filter((k) => k !== tabKey) })),
    );
  }

  findGroupForTab(tabKey: string): UserGroup | undefined {
    return this.getGroups().find((g) => g.tabKeys.includes(tabKey));
  }

  getSortState(): SortState {
    const raw = this.context.workspaceState.get<unknown>(SORT_KEY);
    if (
      raw &&
      typeof raw === 'object' &&
      'name' in raw &&
      'type' in raw &&
      typeof (raw as SortState).type === 'boolean'
    ) {
      return raw as SortState;
    }
    return DEFAULT_SORT;
  }

  async setNameSort(name: NameSort): Promise<void> {
    const state = this.getSortState();
    await this.context.workspaceState.update(SORT_KEY, { ...state, name });
    this._onDidChange.fire();
  }

  async toggleTypeSort(): Promise<void> {
    const state = this.getSortState();
    await this.context.workspaceState.update(SORT_KEY, { ...state, type: !state.type });
    this._onDidChange.fire();
  }

  getFilterMode(): FilterMode {
    const raw = this.context.workspaceState.get<FilterMode>(FILTER_KEY);
    return raw && FILTER_MODES.includes(raw) ? raw : 'none';
  }

  async setFilterMode(mode: FilterMode): Promise<void> {
    await this.context.workspaceState.update(FILTER_KEY, mode);
    this._onDidChange.fire();
  }

  async toggleFilterMode(mode: Exclude<FilterMode, 'none'>): Promise<void> {
    const current = this.getFilterMode();
    await this.setFilterMode(current === mode ? 'none' : mode);
  }
}
