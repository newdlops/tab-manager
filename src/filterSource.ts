import * as vscode from 'vscode';
import type { FilterMode } from './groupStore';
import { resourceUriFor } from './tabUtils';
import { debounce } from './util';

enum GitStatus {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  TYPE_CHANGED = 10,
  ADDED_BY_US = 11,
  ADDED_BY_THEM = 12,
  DELETED_BY_US = 13,
  DELETED_BY_THEM = 14,
  BOTH_ADDED = 15,
  BOTH_DELETED = 16,
  BOTH_MODIFIED = 17,
}

interface Change {
  readonly uri: vscode.Uri;
  readonly status: GitStatus;
}

interface RepoState {
  readonly workingTreeChanges: readonly Change[];
  readonly onDidChange: vscode.Event<void>;
}

interface Repository {
  readonly state: RepoState;
  status(): Promise<void>;
}

interface GitAPI {
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

const READONLY_SCHEMES: ReadonlySet<string> = new Set([
  'git',
  'gitfs',
  'output',
  'walkThroughSnippet',
  'vscode-help',
  'vscode-scm',
]);

export class FilterSource implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private git: GitAPI | undefined;
  private readonly repoDisposables = new Map<Repository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly uriCache = new Map<FilterMode, vscode.Uri[]>();
  private readonly matchSetCache = new Map<FilterMode, Set<string>>();

  private dirtySetCache?: Set<string>;
  private readonly readOnlyCache = new Map<string, boolean>();
  private readonlyPopulationToken = 0;

  private readonly fireDebounced = debounce(() => {
    this.invalidateCaches();
    this._onDidChange.fire();
  }, 50);

  private readonly schedulePopulateReadOnly = debounce(() => {
    void this.populateReadOnly();
  }, 80);

  constructor() {
    this.disposables.push(
      this._onDidChange,
      vscode.languages.onDidChangeDiagnostics(() => this.fireDebounced()),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.fireDebounced();
        this.schedulePopulateReadOnly();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.fireDebounced();
        this.schedulePopulateReadOnly();
      }),
    );
    void this.bootstrapGit();
    this.schedulePopulateReadOnly();
  }

  async refresh(): Promise<void> {
    if (this.git) {
      await Promise.all(
        this.git.repositories.map((r) =>
          r.status().catch(() => {
            /* ignore */
          }),
        ),
      );
    }
    this.readOnlyCache.clear();
    this.invalidateCaches();
    this._onDidChange.fire();
    this.schedulePopulateReadOnly();
  }

  private invalidateCaches(): void {
    this.uriCache.clear();
    this.matchSetCache.clear();
    this.dirtySetCache = undefined;
  }

  isDirty(uri: vscode.Uri): boolean {
    return this.getDirtyKeySet().has(uri.toString());
  }

  getDirtyKeySet(): ReadonlySet<string> {
    if (!this.dirtySetCache) {
      const set = new Set<string>();
      for (const uri of this.computeDirtyUris()) set.add(uri.toString());
      this.dirtySetCache = set;
    }
    return this.dirtySetCache;
  }

  isReadOnly(uri: vscode.Uri): boolean {
    if (READONLY_SCHEMES.has(uri.scheme)) return true;
    return this.readOnlyCache.get(uri.toString()) ?? false;
  }

  private async populateReadOnly(): Promise<void> {
    const token = ++this.readonlyPopulationToken;
    const live = new Set<string>();
    const toStat: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = resourceUriFor(tab);
        if (!uri) continue;
        const key = uri.toString();
        if (live.has(key)) continue;
        live.add(key);
        if (READONLY_SCHEMES.has(uri.scheme)) continue;
        if (this.readOnlyCache.has(key)) continue;
        toStat.push(uri);
      }
    }

    let changed = false;
    for (const key of [...this.readOnlyCache.keys()]) {
      if (!live.has(key)) {
        this.readOnlyCache.delete(key);
        changed = true;
      }
    }

    if (toStat.length > 0) {
      await Promise.all(
        toStat.map(async (uri) => {
          const ro = await this.statReadOnly(uri);
          if (token !== this.readonlyPopulationToken) return;
          const prev = this.readOnlyCache.get(uri.toString());
          if (prev !== ro) {
            this.readOnlyCache.set(uri.toString(), ro);
            changed = true;
          }
        }),
      );
    }

    if (token !== this.readonlyPopulationToken) return;
    if (changed) {
      this.uriCache.delete('readOnly');
      this.matchSetCache.delete('readOnly');
      this._onDidChange.fire();
    }
  }

  private async statReadOnly(uri: vscode.Uri): Promise<boolean> {
    if (uri.scheme !== 'file') return false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return ((stat.permissions ?? 0) & vscode.FilePermission.Readonly) !== 0;
    } catch {
      return false;
    }
  }

  private computeDirtyUris(): vscode.Uri[] {
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!tab.isDirty) continue;
        const uri = resourceUriFor(tab);
        if (!uri) continue;
        const key = uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        uris.push(uri);
      }
    }
    return uris;
  }

  private async bootstrapGit(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return;
    if (!ext.isActive) {
      try {
        await ext.activate();
      } catch {
        return;
      }
    }
    const api = ext.exports.getAPI(1);
    this.git = api;
    for (const repo of api.repositories) this.attach(repo);
    this.disposables.push(
      api.onDidOpenRepository((r) => {
        this.attach(r);
        this.fireDebounced();
      }),
      api.onDidCloseRepository((r) => {
        this.detach(r);
        this.fireDebounced();
      }),
    );
    this.fireDebounced();
  }

  private attach(repo: Repository): void {
    if (this.repoDisposables.has(repo)) return;
    const d = repo.state.onDidChange(() => this.fireDebounced());
    this.repoDisposables.set(repo, d);
  }

  private detach(repo: Repository): void {
    this.repoDisposables.get(repo)?.dispose();
    this.repoDisposables.delete(repo);
  }

  matches(uri: vscode.Uri, mode: FilterMode): boolean {
    if (mode === 'none') return true;
    return this.getUriKeySet(mode).has(uri.toString());
  }

  getUriKeySet(mode: FilterMode): ReadonlySet<string> {
    let set = this.matchSetCache.get(mode);
    if (!set) {
      set = new Set<string>();
      for (const uri of this.getUris(mode)) set.add(uri.toString());
      this.matchSetCache.set(mode, set);
    }
    return set;
  }

  getUris(mode: FilterMode): vscode.Uri[] {
    const cached = this.uriCache.get(mode);
    if (cached) return cached;
    const computed = this.computeUris(mode);
    this.uriCache.set(mode, computed);
    return computed;
  }

  private computeUris(mode: FilterMode): vscode.Uri[] {
    if (mode === 'none') return [];
    if (mode === 'errors') {
      return vscode.languages
        .getDiagnostics()
        .filter(([, diags]) => diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error))
        .map(([uri]) => uri);
    }
    if (mode === 'tabsOnly') {
      const seen = new Set<string>();
      const uris: vscode.Uri[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const uri = resourceUriFor(tab);
          if (!uri) continue;
          const key = uri.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          uris.push(uri);
        }
      }
      return uris;
    }
    if (mode === 'unsaved') {
      return this.computeDirtyUris();
    }
    if (mode === 'readOnly') {
      const seen = new Set<string>();
      const uris: vscode.Uri[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const uri = resourceUriFor(tab);
          if (!uri) continue;
          const key = uri.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          if (this.isReadOnly(uri)) uris.push(uri);
        }
      }
      return uris;
    }
    const wanted = gitStatusFor(mode);
    if (wanted === undefined || !this.git) return [];
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const repo of this.git.repositories) {
      for (const ch of repo.state.workingTreeChanges) {
        if (ch.status !== wanted) continue;
        const key = ch.uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        uris.push(ch.uri);
      }
    }
    return uris;
  }

  dispose(): void {
    for (const d of this.repoDisposables.values()) d.dispose();
    this.repoDisposables.clear();
    for (const d of this.disposables) d.dispose();
  }
}

function gitStatusFor(mode: FilterMode): GitStatus | undefined {
  switch (mode) {
    case 'modified':
      return GitStatus.MODIFIED;
    case 'untracked':
      return GitStatus.UNTRACKED;
    case 'deleted':
      return GitStatus.DELETED;
    default:
      return undefined;
  }
}
