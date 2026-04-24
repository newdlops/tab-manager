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

export class FilterSource implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private git: GitAPI | undefined;
  private readonly repoDisposables = new Map<Repository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly uriCache = new Map<FilterMode, vscode.Uri[]>();
  private readonly matchSetCache = new Map<FilterMode, Set<string>>();

  private readonly fireDebounced = debounce(() => {
    this.invalidateCaches();
    this._onDidChange.fire();
  }, 50);

  constructor() {
    this.disposables.push(
      this._onDidChange,
      vscode.languages.onDidChangeDiagnostics(() => this.fireDebounced()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.fireDebounced()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.fireDebounced()),
    );
    void this.bootstrapGit();
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
    this.invalidateCaches();
    this._onDidChange.fire();
  }

  private invalidateCaches(): void {
    this.uriCache.clear();
    this.matchSetCache.clear();
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
    let set = this.matchSetCache.get(mode);
    if (!set) {
      const uris = this.getUris(mode);
      set = new Set(uris.map((u) => u.toString()));
      this.matchSetCache.set(mode, set);
    }
    return set.has(uri.toString());
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
