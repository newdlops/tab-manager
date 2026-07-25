import * as vscode from 'vscode';
import * as fs from 'fs';
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

const ALL_FILTER_MODES: readonly ActiveFilterMode[] = [
  'modified',
  'untracked',
  'deleted',
  'errors',
  'tabsOnly',
  'unsaved',
  'readOnly',
  'prComments',
  'prFiles',
  'comparison',
];
const GIT_FILTER_MODES: readonly ActiveFilterMode[] = [
  'modified',
  'untracked',
  'deleted',
];
const PULL_REQUEST_FILTER_MODES: readonly ActiveFilterMode[] = ['prComments', 'prFiles'];
const TAB_STRUCTURE_FILTER_MODES: readonly ActiveFilterMode[] = [
  'tabsOnly',
  'untracked',
  'readOnly',
];

type ActiveFilterMode = Exclude<FilterMode, 'none'>;

export interface PullRequestFileSource {
  readonly onDidChangePullRequestData: vscode.Event<void>;
  getCommentedUris(): readonly vscode.Uri[];
  getPullRequestFileUris(): readonly vscode.Uri[];
  getPullRequestFileEntries?(): readonly FilterFileEntry[];
}

export interface FilterFileEntry {
  readonly uri: vscode.Uri;
  readonly status?: string;
  readonly command?: vscode.Command;
}

export interface ComparisonFileSource {
  readonly onDidChange: vscode.Event<void>;
  getEntries(): readonly FilterFileEntry[];
  refresh?(): void;
}

export interface FilterSourceChangeEvent {
  readonly modes: readonly ActiveFilterMode[];
  readonly affectsOpenTabMetadata: boolean;
  readonly affectsDirtyDecorations: boolean;
}

export type FileSystemChangeKind = 'created' | 'changed' | 'deleted';

export class FilterSource implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<FilterSourceChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  private git: GitAPI | undefined;
  private readonly repoDisposables = new Map<Repository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private pullRequestFileSource: PullRequestFileSource | undefined;
  private pullRequestFileSourceDisposable: vscode.Disposable | undefined;
  private comparisonFileSource: ComparisonFileSource | undefined;
  private comparisonFileSourceDisposable: vscode.Disposable | undefined;

  private readonly uriCache = new Map<FilterMode, vscode.Uri[]>();
  private readonly matchSetCache = new Map<FilterMode, Set<string>>();

  private dirtySetCache?: Set<string>;
  private openTabUriKeyCache?: Set<string>;
  private readonly readOnlyCache = new Map<string, boolean>();
  private readonly invalidatedReadOnlyKeys = new Set<string>();
  private readonly missingCache = new Map<string, boolean>();
  private readonlyPopulationToken = 0;
  private dirtySignature = '';
  private readonly pendingModes = new Set<ActiveFilterMode>();
  private pendingAffectsOpenTabMetadata = false;
  private pendingAffectsDirtyDecorations = false;

  private readonly fireDebounced = debounce(() => {
    this.flushPendingChange();
  }, 50);

  private readonly schedulePopulateReadOnly = debounce(() => {
    void this.populateReadOnly();
  }, 80);

  constructor(
    pullRequestFileSource?: PullRequestFileSource,
    comparisonFileSource?: ComparisonFileSource,
  ) {
    this.dirtySignature = this.computeDirtySignature();
    this.disposables.push(
      this._onDidChange,
      vscode.languages.onDidChangeDiagnostics(() => this.queueChange(['errors'])),
      vscode.window.tabGroups.onDidChangeTabs((event) => this.handleTabChange(event)),
      vscode.window.tabGroups.onDidChangeTabGroups((event) => this.handleTabGroupChange(event)),
    );
    if (pullRequestFileSource) this.setPullRequestFileSource(pullRequestFileSource);
    if (comparisonFileSource) this.setComparisonFileSource(comparisonFileSource);
    void this.bootstrapGit();
    this.schedulePopulateReadOnly();
  }

  setPullRequestFileSource(source: PullRequestFileSource | undefined): void {
    this.pullRequestFileSourceDisposable?.dispose();
    this.pullRequestFileSource = source;
    this.pullRequestFileSourceDisposable = source?.onDidChangePullRequestData(() =>
      this.queueChange(PULL_REQUEST_FILTER_MODES),
    );
    this.queueChange(PULL_REQUEST_FILTER_MODES);
  }

  /** Git Simple Compare의 활성 비교 소스를 교체하고 comparison 필터 캐시를 갱신한다. */
  setComparisonFileSource(source: ComparisonFileSource | undefined): void {
    this.comparisonFileSourceDisposable?.dispose();
    this.comparisonFileSource = source;
    this.comparisonFileSourceDisposable = source?.onDidChange(() =>
      this.queueChange(['comparison']),
    );
    this.queueChange(['comparison']);
  }

  async refresh(): Promise<void> {
    this.readonlyPopulationToken++;
    if (this.git) {
      await Promise.all(
        this.git.repositories.map((r) =>
          r.status().catch(() => {
            /* ignore */
          }),
        ),
      );
    }
    this.comparisonFileSource?.refresh?.();
    this.readOnlyCache.clear();
    this.invalidatedReadOnlyKeys.clear();
    this.missingCache.clear();
    this.openTabUriKeyCache = undefined;
    this.invalidateCaches();
    this._onDidChange.fire({
      modes: ALL_FILTER_MODES,
      affectsOpenTabMetadata: true,
      affectsDirtyDecorations: true,
    });
    this.schedulePopulateReadOnly();
  }

  private queueChange(
    modes: readonly ActiveFilterMode[],
    options: {
      affectsOpenTabMetadata?: boolean;
      affectsDirtyDecorations?: boolean;
    } = {},
  ): void {
    for (const mode of modes) this.pendingModes.add(mode);
    this.pendingAffectsOpenTabMetadata ||= !!options.affectsOpenTabMetadata;
    this.pendingAffectsDirtyDecorations ||= !!options.affectsDirtyDecorations;
    this.fireDebounced();
  }

  private flushPendingChange(): void {
    const modes = [...this.pendingModes];
    const event: FilterSourceChangeEvent = {
      modes,
      affectsOpenTabMetadata: this.pendingAffectsOpenTabMetadata,
      affectsDirtyDecorations: this.pendingAffectsDirtyDecorations,
    };
    this.pendingModes.clear();
    this.pendingAffectsOpenTabMetadata = false;
    this.pendingAffectsDirtyDecorations = false;
    if (
      event.modes.length === 0 &&
      !event.affectsOpenTabMetadata &&
      !event.affectsDirtyDecorations
    ) {
      return;
    }
    this.invalidateCaches(event.modes);
    this._onDidChange.fire(event);
  }

  private invalidateCaches(modes: readonly ActiveFilterMode[] = ALL_FILTER_MODES): void {
    for (const mode of modes) {
      this.uriCache.delete(mode);
      this.matchSetCache.delete(mode);
      if (mode === 'unsaved') this.dirtySetCache = undefined;
    }
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

  isMissing(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) return false;
    const key = uri.toString();
    const cached = this.missingCache.get(key);
    if (cached !== undefined) return cached;
    const missing = !fs.existsSync(uri.fsPath);
    this.missingCache.set(key, missing);
    return missing;
  }

  notifyFileSystemChange(
    uri: vscode.Uri,
    kind: FileSystemChangeKind = 'changed',
  ): boolean {
    const key = uri.toString();
    if (!this.getOpenTabUriKeySet().has(key)) return false;

    if (kind === 'created' || kind === 'deleted') {
      this.missingCache.set(key, kind === 'deleted');
      const modes: ActiveFilterMode[] = ['untracked'];
      if (kind === 'deleted') {
        if (this.readOnlyCache.get(key) === true) modes.push('readOnly');
        this.readOnlyCache.set(key, false);
        this.invalidatedReadOnlyKeys.delete(key);
      } else {
        this.invalidatedReadOnlyKeys.add(key);
        this.schedulePopulateReadOnly();
      }
      this.queueChange(modes, { affectsOpenTabMetadata: true });
    } else {
      this.missingCache.set(key, false);
      this.invalidatedReadOnlyKeys.add(key);
      this.schedulePopulateReadOnly();
    }
    return true;
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
        if (this.readOnlyCache.has(key) && !this.invalidatedReadOnlyKeys.has(key)) continue;
        toStat.push(uri);
      }
    }

    let changed = false;
    for (const key of [...this.readOnlyCache.keys()]) {
      if (!live.has(key)) {
        this.readOnlyCache.delete(key);
        this.invalidatedReadOnlyKeys.delete(key);
        changed = true;
      }
    }
    for (const key of [...this.missingCache.keys()]) {
      if (!live.has(key)) this.missingCache.delete(key);
    }

    if (toStat.length > 0) {
      await Promise.all(
        toStat.map(async (uri) => {
          const ro = await this.statReadOnly(uri);
          if (token !== this.readonlyPopulationToken) return;
          const key = uri.toString();
          const prev = this.readOnlyCache.get(key);
          if (prev !== ro) {
            this.readOnlyCache.set(key, ro);
            changed = true;
          }
          this.invalidatedReadOnlyKeys.delete(key);
        }),
      );
    }

    if (token !== this.readonlyPopulationToken) return;
    if (changed) {
      this.queueChange(['readOnly'], { affectsOpenTabMetadata: true });
    }
  }

  private handleTabChange(event: vscode.TabChangeEvent): void {
    const structureChanged = event.opened.length > 0 || event.closed.length > 0;
    if (structureChanged || event.changed.length > 0) this.openTabUriKeyCache = undefined;
    if (structureChanged) {
      this.queueChange(TAB_STRUCTURE_FILTER_MODES);
      this.schedulePopulateReadOnly();
    }
    if (this.syncDirtySignature()) {
      this.queueChange(['unsaved'], { affectsDirtyDecorations: true });
    }
  }

  private handleTabGroupChange(event: vscode.TabGroupChangeEvent): void {
    const structureChanged = event.opened.length > 0 || event.closed.length > 0;
    if (!structureChanged) return;
    this.openTabUriKeyCache = undefined;
    this.queueChange(TAB_STRUCTURE_FILTER_MODES);
    this.schedulePopulateReadOnly();
  }

  private syncDirtySignature(): boolean {
    const next = this.computeDirtySignature();
    if (next === this.dirtySignature) return false;
    this.dirtySignature = next;
    return true;
  }

  private computeDirtySignature(): string {
    return this.computeDirtyUris()
      .map((uri) => uri.toString())
      .sort()
      .join('\n');
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

  private computeMissingOpenTabUris(): vscode.Uri[] {
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = resourceUriFor(tab);
        if (!uri || !this.isMissing(uri)) continue;
        const key = uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        uris.push(uri);
      }
    }
    return uris;
  }

  private getOpenTabUriKeySet(): ReadonlySet<string> {
    if (!this.openTabUriKeyCache) {
      const keys = new Set<string>();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const uri = resourceUriFor(tab);
          if (uri) keys.add(uri.toString());
        }
      }
      this.openTabUriKeyCache = keys;
    }
    return this.openTabUriKeyCache;
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
        this.queueChange(GIT_FILTER_MODES);
      }),
      api.onDidCloseRepository((r) => {
        this.detach(r);
        this.queueChange(GIT_FILTER_MODES);
      }),
    );
    this.queueChange(GIT_FILTER_MODES);
  }

  private attach(repo: Repository): void {
    if (this.repoDisposables.has(repo)) return;
    const d = repo.state.onDidChange(() => this.queueChange(GIT_FILTER_MODES));
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

  /** 필터가 가진 URI와 선택적 git 상태를 Explorer가 공통 처리할 수 있게 반환한다. */
  getEntries(mode: FilterMode): FilterFileEntry[] {
    if (mode === 'comparison') return [...(this.comparisonFileSource?.getEntries() ?? [])];
    if (mode === 'prFiles') {
      const entries = this.pullRequestFileSource?.getPullRequestFileEntries?.();
      if (entries) return [...entries];
    }
    return this.getUris(mode).map((uri) => ({
      uri,
      status: mode === 'deleted' ? 'D' : undefined,
    }));
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
    if (mode === 'prComments') {
      return [...(this.pullRequestFileSource?.getCommentedUris() ?? [])];
    }
    if (mode === 'prFiles') {
      return [...(this.pullRequestFileSource?.getPullRequestFileUris() ?? [])];
    }
    if (mode === 'comparison') {
      return [...(this.comparisonFileSource?.getEntries() ?? [])].map((entry) => entry.uri);
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
    if (wanted === undefined) return [];
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    const addUri = (uri: vscode.Uri) => {
      const key = uri.toString();
      if (seen.has(key)) return;
      seen.add(key);
      uris.push(uri);
    };
    if (this.git) {
      for (const repo of this.git.repositories) {
        for (const ch of repo.state.workingTreeChanges) {
          if (ch.status !== wanted) continue;
          addUri(ch.uri);
        }
      }
    }
    if (mode === 'untracked') {
      for (const uri of this.computeMissingOpenTabUris()) addUri(uri);
    }
    return uris;
  }

  dispose(): void {
    this.pullRequestFileSourceDisposable?.dispose();
    this.comparisonFileSourceDisposable?.dispose();
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
