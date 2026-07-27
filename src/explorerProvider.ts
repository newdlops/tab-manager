import * as vscode from 'vscode';
import * as path from 'path';
import type { ExplorerDisplayOptions, GroupStore, FilterMode, SortState } from './groupStore';
import type {
  FileSystemChangeKind,
  FilterSource,
  FilterSourceChangeEvent,
} from './filterSource';
import { formatOpenError } from './openResource';
import { resourceUriFor } from './tabUtils';
import { debounce, fileContextValue } from './util';

export type FileTreeNode =
  | WorkspaceFolderNode
  | DirectoryNode
  | FileNode
  | PendingNode
  | ExplorerErrorNode;
export type PendingKind = 'file' | 'folder';

interface FileNodeMetadata {
  descriptionParts?: readonly string[];
  command?: vscode.Command;
}

export class WorkspaceFolderNode extends vscode.TreeItem {
  constructor(public readonly folder: vscode.WorkspaceFolder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri = folder.uri;
    this.iconPath = new vscode.ThemeIcon('root-folder');
    this.contextValue = 'workspaceFolder';
    this.id = `wsf:${folder.uri.toString()}`;
  }
}

export class DirectoryNode extends vscode.TreeItem {
  constructor(public readonly uri: vscode.Uri, expanded = false) {
    super(
      baseName(uri),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.resourceUri = uri;
    this.contextValue = 'directory';
    this.id = `dir:${uri.toString()}`;
  }
}

export class PendingNode extends vscode.TreeItem {
  constructor(public readonly kind: PendingKind, public readonly name: string) {
    super(name || `(enter ${kind} name)`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = kind === 'file' ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
    this.description = `new ${kind}`;
    this.contextValue = 'pending';
    this.id = `pending:${kind}`;
  }
}

export class ExplorerErrorNode extends vscode.TreeItem {
  constructor(
    public readonly folderUri: vscode.Uri,
    errorMessage: string,
  ) {
    const folderName = baseName(folderUri) || folderUri.authority || folderUri.scheme;
    super('Unable to read folder', vscode.TreeItemCollapsibleState.None);
    this.description = folderName;
    this.id = `error:${folderUri.toString()}`;
    this.contextValue = 'explorerError';
    this.iconPath = new vscode.ThemeIcon('error');
    const location = folderUri.scheme === 'file' ? folderUri.fsPath : folderUri.toString();
    this.tooltip = `${location}\n${errorMessage}`;
    this.accessibilityInformation = {
      label: `Unable to read folder ${folderName}. ${errorMessage}`,
      role: 'treeitem',
    };
  }
}

export class FileNode extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly isDeleted = false,
    metadata: FileNodeMetadata = {},
  ) {
    const name = baseName(uri);
    super(isDeleted ? strikeThrough(name) : name, vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.id = `file:${isDeleted ? 'deleted:' : ''}${uri.toString()}`;
    if (isDeleted) {
      this.description = 'deleted';
      this.contextValue = fileContextValue(name, { deleted: true });
      const actionTitle = metadata.command?.title;
      this.tooltip = actionTitle
        ? `${uri.fsPath} (deleted)\n${actionTitle}`
        : `${uri.fsPath} (deleted)`;
      this.accessibilityInformation = {
        label: actionTitle ? `${name}, deleted, ${actionTitle}` : `${name}, deleted`,
        role: 'treeitem',
      };
      this.command = metadata.command;
    } else {
      this.contextValue = fileContextValue(baseName(uri));
      this.tooltip = `${uri.fsPath}\nOpen File`;
      const descriptionParts = metadata.descriptionParts ?? [];
      if (descriptionParts.length) {
        this.description = descriptionParts.join(' · ');
      }
      this.accessibilityInformation = {
        label: [name, uri.fsPath, ...descriptionParts, 'Open File'].join(', '),
        role: 'treeitem',
      };
      this.command = {
        command: 'tabManager.explorer.open',
        title: 'Open File',
        arguments: [uri],
      };
    }
  }
}

export function baseName(uri: vscode.Uri): string {
  const p = uri.path;
  return p.slice(p.lastIndexOf('/') + 1);
}

export function parentUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: path.posix.dirname(uri.path) });
}

const INTERNAL_MIME = 'application/vnd.code.tree.tabmanagerexplorer';

interface CachedFileMetadata {
  size: number;
  lineCount?: number;
  lineCountComputed: boolean;
}

const FILE_METADATA_CONCURRENCY = 8;
const MAX_TARGETED_DIRECTORY_REFRESHES = 8;

export class ExplorerProvider
  implements
    vscode.TreeDataProvider<FileTreeNode>,
    vscode.TreeDragAndDropController<FileTreeNode>,
    vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dropMimeTypes = [INTERNAL_MIME, 'text/uri-list'];
  readonly dragMimeTypes = ['text/uri-list'];

  private cache?: {
    mode: FilterMode;
    matching: ReadonlySet<string>;
    ancestors: Set<string>;
    deletedKeys: ReadonlySet<string>;
    deletedCommandsByUri?: ReadonlyMap<string, vscode.Command>;
    deletedFilesByParent?: Map<string, vscode.Uri[]>;
    deletedDirectoriesByParent?: Map<string, vscode.Uri[]>;
  };
  private readonly dirCache = new Map<string, [string, vscode.FileType][]>();
  private readonly fileMetadataCache = new Map<string, CachedFileMetadata>();
  private readonly directoryWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly openTabDirectoryKeys = new Set<string>();
  private readonly directoryNodes = new Map<string, DirectoryNode>();
  private readonly workspaceFolderNodes = new Map<string, WorkspaceFolderNode>();
  private readonly pendingDirectoryRefreshes = new Map<string, vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private pending?: { parentUri: vscode.Uri; kind: PendingKind; name: string };
  private lastFilterMode: FilterMode;
  private lastSortState: SortState;
  private lastExplorerDisplayOptions: ExplorerDisplayOptions;
  private readonly fireWatchedDirectoryChange = debounce(
    () => this.flushWatchedDirectoryChanges(),
    40,
  );
  private readonly scheduleSyncOpenTabDirectoryWatchers = debounce(
    () => this.syncOpenTabDirectoryWatchers(),
    30,
  );

  constructor(
    private readonly store: GroupStore,
    private readonly filter: FilterSource,
  ) {
    this.lastFilterMode = store.getFilterMode();
    this.lastSortState = store.getSortState();
    this.lastExplorerDisplayOptions = store.getExplorerDisplayOptions();
    this.disposables.push(
      store.onDidChange(() => this.refreshStoreState()),
      filter.onDidChange((event) => this.refreshFilter(event)),
      vscode.window.tabGroups.onDidChangeTabs(() =>
        this.scheduleSyncOpenTabDirectoryWatchers(),
      ),
      vscode.window.tabGroups.onDidChangeTabGroups(() =>
        this.scheduleSyncOpenTabDirectoryWatchers(),
      ),
    );
    this.syncOpenTabDirectoryWatchers();
  }

  handleDrag(
    source: readonly FileTreeNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const uris = source.map(nodeUri).filter((u): u is vscode.Uri => u !== undefined);
    if (uris.length === 0) return;
    dataTransfer.set(INTERNAL_MIME, new vscode.DataTransferItem(uris));
    dataTransfer.set(
      'text/uri-list',
      new vscode.DataTransferItem(uris.map((u) => u.toString()).join('\r\n')),
    );
  }

  async handleDrop(
    target: FileTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const dest = await resolveDropDestination(target);
    if (!dest) return;

    let sources: vscode.Uri[] = [];
    try {
      sources = await readDropSources(dataTransfer);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to read dropped items: ${formatOpenError(error)}`);
      return;
    }
    if (sources.length === 0) return;

    for (const src of sources) {
      if (isSameOrAncestor(src, dest)) continue;
      const name = baseName(src);
      const newUri = vscode.Uri.joinPath(dest, name);
      if (newUri.toString() === src.toString()) continue;
      try {
        if (await uriExists(newUri)) {
          const pick = await vscode.window.showWarningMessage(
            `"${name}" already exists in destination. Overwrite?`,
            { modal: true },
            'Overwrite',
            'Skip',
          );
          if (pick !== 'Overwrite') continue;
          await vscode.workspace.fs.rename(src, newUri, { overwrite: true });
        } else {
          await vscode.workspace.fs.rename(src, newUri, { overwrite: false });
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to move ${name}: ${formatOpenError(e)}`);
      }
    }
  }

  refresh(): void {
    this.cache = undefined;
    this.dirCache.clear();
    this.fileMetadataCache.clear();
    this.directoryNodes.clear();
    this.workspaceFolderNodes.clear();
    this.pendingDirectoryRefreshes.clear();
    this.pruneDirectoryWatchers();
    this._onDidChangeTreeData.fire(undefined);
  }

  requestRedraw(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  private refreshFilter(event?: FilterSourceChangeEvent): void {
    const mode = this.store.getFilterMode();
    if (event && (mode === 'none' || !event.modes.includes(mode))) return;
    this.cache = undefined;
    this.pruneDirectoryWatchersForFilter(mode);
    this._onDidChangeTreeData.fire(undefined);
  }

  private refreshStoreState(): void {
    const mode = this.store.getFilterMode();
    const sort = this.store.getSortState();
    const displayOptions = this.store.getExplorerDisplayOptions();
    const filterChanged = mode !== this.lastFilterMode;
    const sortChanged =
      sort.name !== this.lastSortState.name || sort.type !== this.lastSortState.type;
    const displayChanged =
      displayOptions.fileSize !== this.lastExplorerDisplayOptions.fileSize ||
      displayOptions.lineCount !== this.lastExplorerDisplayOptions.lineCount;
    this.lastFilterMode = mode;
    this.lastSortState = sort;
    this.lastExplorerDisplayOptions = displayOptions;

    if (filterChanged) this.refreshFilter();
    else if (sortChanged || displayChanged) this.requestRedraw();
  }

  invalidateDirectory(uri: vscode.Uri): boolean {
    return this.dirCache.delete(uri.toString());
  }

  unwatchNode(node: FileTreeNode): void {
    const uri = nodeUri(node);
    if (!uri) return;
    this.unwatchDirectoryTree(uri);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposeDirectoryWatchers();
    this.pendingDirectoryRefreshes.clear();
    this._onDidChangeTreeData.dispose();
  }

  startPending(parentUri: vscode.Uri, kind: PendingKind): void {
    this.pending = { parentUri, kind, name: '' };
    this.invalidateDirectory(parentUri);
    this.refreshDirectory(parentUri);
  }

  updatePendingName(name: string): void {
    if (!this.pending) return;
    this.pending.name = name;
    this.refreshDirectory(this.pending.parentUri);
  }

  clearPending(): void {
    if (!this.pending) return;
    const parent = this.pending.parentUri;
    this.pending = undefined;
    this.invalidateDirectory(parent);
    this.refreshDirectory(parent);
  }

  private isPendingAt(uri: vscode.Uri): boolean {
    return !!this.pending && this.pending.parentUri.toString() === uri.toString();
  }

  private isPendingAncestor(uri: vscode.Uri): boolean {
    if (!this.pending) return false;
    const target = this.pending.parentUri.toString();
    const current = uri.toString();
    return target === current || target.startsWith(current + '/');
  }

  getTreeItem(element: FileTreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: FileTreeNode): FileTreeNode | undefined {
    if (element instanceof WorkspaceFolderNode) return undefined;
    if (element instanceof PendingNode) return undefined;
    if (element instanceof ExplorerErrorNode) return undefined;
    const uri = element instanceof DirectoryNode ? element.uri : element.uri;
    const parent = parentUri(uri);
    if (parent.toString() === uri.toString()) return undefined;

    const folders = vscode.workspace.workspaceFolders ?? [];
    const matchingFolder = folders.find((f) => f.uri.toString() === parent.toString());
    if (matchingFolder) {
      return folders.length === 1 ? undefined : this.workspaceFolderNode(matchingFolder);
    }
    return this.directoryNode(parent);
  }

  nodeForUri(uri: vscode.Uri): FileTreeNode | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const containing = folders.find((f) => isInsideFolder(uri, f.uri));
    if (!containing) return undefined;
    if (uri.toString() === containing.uri.toString()) {
      return folders.length === 1 ? undefined : this.workspaceFolderNode(containing);
    }
    return new FileNode(uri);
  }

  async getChildren(element?: FileTreeNode): Promise<FileTreeNode[]> {
    const mode = this.store.getFilterMode();

    if (!element) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return [];
      if (folders.length === 1) return this.readDirectory(folders[0].uri, mode);
      if (mode === 'none') return folders.map((folder) => this.workspaceFolderNode(folder));
      this.ensureCache(mode);
      return folders
        .filter((folder) => this.cache!.ancestors.has(folder.uri.toString()))
        .map((folder) => this.workspaceFolderNode(folder));
    }
    if (element instanceof WorkspaceFolderNode) {
      this.workspaceFolderNodes.set(element.folder.uri.toString(), element);
      return this.readDirectory(element.folder.uri, mode);
    }
    if (element instanceof DirectoryNode) {
      this.directoryNodes.set(element.uri.toString(), element);
      return this.readDirectory(element.uri, mode);
    }
    return [];
  }

  private async readDirectory(folder: vscode.Uri, mode: FilterMode): Promise<FileTreeNode[]> {
    const cacheKey = folder.toString();
    let entries = this.dirCache.get(cacheKey);
    if (!entries) {
      try {
        entries = await vscode.workspace.fs.readDirectory(folder);
      } catch (error) {
        if (!this.isDeletedGhostDirectory(folder, mode)) {
          return [new ExplorerErrorNode(folder, formatOpenError(error))];
        }
        entries = [];
      }
      this.dirCache.set(cacheKey, entries);
    }
    this.watchDirectory(folder);

    this.ensureCache(mode);
    const matching = this.cache!.matching;
    const ancestors = this.cache!.ancestors;
    const displayOptions = this.store.getExplorerDisplayOptions();
    const present = new Set<string>();

    const nodes: FileTreeNode[] = [];
    const liveFiles: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      const uri = vscode.Uri.joinPath(folder, name);
      const key = uri.toString();
      present.add(key);
      if (type & vscode.FileType.Directory) {
        if (mode === 'none' || ancestors.has(key)) {
          nodes.push(this.directoryNode(uri, this.isPendingAncestor(uri)));
        }
      } else if (type & vscode.FileType.File) {
        if (mode === 'none' || matching.has(key)) {
          const isDeleted = this.cache!.deletedKeys.has(key);
          if (isDeleted) {
            nodes.push(
              new FileNode(uri, true, {
                command: this.cache!.deletedCommandsByUri?.get(key),
              }),
            );
          } else {
            liveFiles.push(uri);
          }
        }
      }
    }

    if (displayOptions.fileSize || displayOptions.lineCount) {
      nodes.push(
        ...(await mapWithConcurrency(
          liveFiles,
          FILE_METADATA_CONCURRENCY,
          (uri) => this.createFileNode(uri, displayOptions),
        )),
      );
    } else {
      nodes.push(...liveFiles.map((uri) => new FileNode(uri)));
    }

    const ghostDirectories = this.cache?.deletedDirectoriesByParent?.get(cacheKey) ?? [];
    for (const directoryUri of ghostDirectories) {
      if (present.has(directoryUri.toString())) continue;
      present.add(directoryUri.toString());
      nodes.push(this.directoryNode(directoryUri, this.isPendingAncestor(directoryUri)));
    }

    const deletedFiles = this.cache?.deletedFilesByParent?.get(cacheKey) ?? [];
    for (const deletedUri of deletedFiles) {
      if (present.has(deletedUri.toString())) continue;
      present.add(deletedUri.toString());
      nodes.push(
        new FileNode(deletedUri, true, {
          command: this.cache?.deletedCommandsByUri?.get(deletedUri.toString()),
        }),
      );
    }

    nodes.sort(makeCompareNodes(this.store.getSortState()));

    if (this.pending && this.isPendingAt(folder)) {
      nodes.unshift(new PendingNode(this.pending.kind, this.pending.name));
    }

    return nodes;
  }

  private async createFileNode(
    uri: vscode.Uri,
    displayOptions: ExplorerDisplayOptions,
  ): Promise<FileNode> {
    const descriptionParts = await this.getFileDescriptionParts(uri, displayOptions);
    return new FileNode(uri, false, { descriptionParts });
  }

  private async getFileDescriptionParts(
    uri: vscode.Uri,
    displayOptions: ExplorerDisplayOptions,
  ): Promise<string[]> {
    if (!displayOptions.fileSize && !displayOptions.lineCount) return [];

    try {
      const key = uri.toString();
      let metadata = this.fileMetadataCache.get(key);
      if (!metadata) {
        const stat = await vscode.workspace.fs.stat(uri);
        if (!(stat.type & vscode.FileType.File)) return [];
        metadata = {
          size: stat.size,
          lineCountComputed: false,
        };
        this.fileMetadataCache.set(key, metadata);
      }

      if (displayOptions.lineCount && !metadata.lineCountComputed) {
        metadata.lineCount = countLines(await vscode.workspace.fs.readFile(uri));
        metadata.lineCountComputed = true;
      }

      const parts: string[] = [];
      if (displayOptions.fileSize) parts.push(formatFileSize(metadata.size));
      if (displayOptions.lineCount && metadata.lineCount !== undefined) {
        parts.push(formatLineCount(metadata.lineCount));
      }
      return parts;
    } catch {
      return [];
    }
  }

  private watchDirectory(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.directoryWatchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(uri, '*'),
      false,
      false,
      false,
    );
    this.directoryWatchers.set(key, watcher);
    watcher.onDidCreate((changedUri) =>
      this.handleWatchedDirectoryChange(uri, changedUri, 'created'),
    );
    watcher.onDidChange((changedUri) =>
      this.handleWatchedDirectoryChange(uri, changedUri, 'changed'),
    );
    watcher.onDidDelete((changedUri) =>
      this.handleWatchedDirectoryChange(uri, changedUri, 'deleted'),
    );
  }

  private handleWatchedDirectoryChange(
    parent: vscode.Uri,
    uri: vscode.Uri,
    kind: FileSystemChangeKind,
  ): void {
    const parentWasCached = this.dirCache.has(parent.toString());
    this.fileMetadataCache.delete(uri.toString());
    this.filter.notifyFileSystemChange(uri, kind);

    if (kind === 'changed') {
      const displayOptions = this.store.getExplorerDisplayOptions();
      if (parentWasCached && (displayOptions.fileSize || displayOptions.lineCount)) {
        this.scheduleDirectoryRefresh(parent);
      }
      return;
    }

    const parentInvalidated = this.invalidateDirectory(parent);
    const childInvalidated = this.hasCachedDirectoryTree(uri);
    if (kind === 'deleted') this.unwatchDirectoryTree(uri);
    else this.invalidateDirectory(uri);
    if (parentInvalidated || childInvalidated) this.scheduleDirectoryRefresh(parent);
  }

  private unwatchDirectoryTree(uri: vscode.Uri): void {
    const uriKey = uri.toString();
    deleteUriTreeEntries(this.dirCache, uriKey);
    deleteUriTreeEntries(this.fileMetadataCache, uriKey);
    deleteUriTreeEntries(this.directoryNodes, uriKey);
    for (const [key, watcher] of this.directoryWatchers) {
      if (isUriKeyInTree(uriKey, key) && !this.openTabDirectoryKeys.has(key)) {
        watcher.dispose();
        this.directoryWatchers.delete(key);
      }
    }
  }

  private hasCachedDirectoryTree(uri: vscode.Uri): boolean {
    const uriKey = uri.toString();
    for (const key of this.dirCache.keys()) {
      if (isUriKeyInTree(uriKey, key)) return true;
    }
    return false;
  }

  private scheduleDirectoryRefresh(uri: vscode.Uri): void {
    this.pendingDirectoryRefreshes.set(uri.toString(), uri);
    this.fireWatchedDirectoryChange();
  }

  private flushWatchedDirectoryChanges(): void {
    const parents = [...this.pendingDirectoryRefreshes.values()];
    this.pendingDirectoryRefreshes.clear();
    if (parents.length === 0) return;

    if (parents.length > MAX_TARGETED_DIRECTORY_REFRESHES) {
      this.requestRedraw();
      return;
    }

    const targets = new Map<string, FileTreeNode>();
    for (const parent of parents) {
      const target = this.directoryRefreshTarget(parent);
      if (!target) {
        this.requestRedraw();
        return;
      }
      targets.set(target.id ?? parent.toString(), target);
    }
    for (const target of targets.values()) this._onDidChangeTreeData.fire(target);
  }

  private refreshDirectory(uri: vscode.Uri): void {
    const target = this.directoryRefreshTarget(uri);
    this._onDidChangeTreeData.fire(target);
  }

  private directoryRefreshTarget(uri: vscode.Uri): FileTreeNode | undefined {
    const key = uri.toString();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.find((candidate) => candidate.uri.toString() === key);
    if (folder) return folders.length === 1 ? undefined : this.workspaceFolderNode(folder);
    return this.directoryNodes.get(key);
  }

  private directoryNode(uri: vscode.Uri, expanded = false): DirectoryNode {
    const key = uri.toString();
    let node = this.directoryNodes.get(key);
    if (!node) {
      node = new DirectoryNode(uri, expanded);
      this.directoryNodes.set(key, node);
    } else if (expanded) {
      node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }
    return node;
  }

  private workspaceFolderNode(folder: vscode.WorkspaceFolder): WorkspaceFolderNode {
    const key = folder.uri.toString();
    let node = this.workspaceFolderNodes.get(key);
    if (!node) {
      node = new WorkspaceFolderNode(folder);
      this.workspaceFolderNodes.set(key, node);
    }
    return node;
  }

  private pruneDirectoryWatchers(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const [key, watcher] of this.directoryWatchers) {
      const uri = vscode.Uri.parse(key);
      if (folders.some((folder) => isInsideFolder(uri, folder.uri))) continue;
      watcher.dispose();
      this.directoryWatchers.delete(key);
    }
  }

  private pruneDirectoryWatchersForFilter(mode: FilterMode): void {
    if (mode === 'none') return;
    this.ensureCache(mode);
    const workspaceRoots = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()),
    );
    for (const [key, watcher] of this.directoryWatchers) {
      if (
        workspaceRoots.has(key) ||
        this.openTabDirectoryKeys.has(key) ||
        this.cache!.ancestors.has(key)
      ) {
        continue;
      }
      watcher.dispose();
      this.directoryWatchers.delete(key);
    }
  }

  private syncOpenTabDirectoryWatchers(): void {
    const nextKeys = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = resourceUriFor(tab);
        if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) continue;
        const parent = parentUri(uri);
        const key = parent.toString();
        if (nextKeys.has(key)) continue;
        nextKeys.add(key);
        this.watchDirectory(parent);
      }
    }

    this.openTabDirectoryKeys.clear();
    for (const key of nextKeys) this.openTabDirectoryKeys.add(key);

    for (const [key, watcher] of this.directoryWatchers) {
      if (this.openTabDirectoryKeys.has(key) || this.dirCache.has(key)) continue;
      watcher.dispose();
      this.directoryWatchers.delete(key);
    }
  }

  private disposeDirectoryWatchers(): void {
    for (const watcher of this.directoryWatchers.values()) watcher.dispose();
    this.directoryWatchers.clear();
  }

  private ensureCache(mode: FilterMode): void {
    if (this.cache?.mode === mode) return;
    if (mode === 'none') {
      this.cache = {
        mode,
        matching: new Set(),
        ancestors: new Set(),
        deletedKeys: new Set(),
      };
      return;
    }
    const entries = this.filter.getEntries(mode);
    const uris = entries.map((entry) => entry.uri);
    const matching = this.filter.getUriKeySet(mode);
    const ancestors = new Set<string>();
    const deletedEntries = entries.filter((entry) => isDeletedStatus(entry.status));
    const deletedKeys = new Set(deletedEntries.map((entry) => entry.uri.toString()));
    const deletedCommandsByUri = new Map<string, vscode.Command>();
    for (const entry of deletedEntries) {
      if (entry.command) deletedCommandsByUri.set(entry.uri.toString(), entry.command);
    }
    const deletedFilesByParent = deletedEntries.length > 0
      ? new Map<string, vscode.Uri[]>()
      : undefined;
    const deletedDirectoriesByParent = deletedEntries.length > 0
      ? new Map<string, vscode.Uri[]>()
      : undefined;
    for (const uri of uris) {
      let p = parentUri(uri);
      while (true) {
        const s = p.toString();
        if (ancestors.has(s)) break;
        ancestors.add(s);
        const np = parentUri(p);
        if (np.toString() === s) break;
        p = np;
      }
    }
    for (const entry of deletedEntries) {
      const parent = parentUri(entry.uri);
      appendUri(deletedFilesByParent!, parent, entry.uri);

      const workspaceRoot = vscode.workspace.workspaceFolders?.find((folder) =>
        isInsideFolder(entry.uri, folder.uri),
      )?.uri;
      if (!workspaceRoot) continue;

      let directory = parent;
      while (directory.toString() !== workspaceRoot.toString()) {
        const directoryParent = parentUri(directory);
        if (directoryParent.toString() === directory.toString()) break;
        appendUri(deletedDirectoriesByParent!, directoryParent, directory);
        directory = directoryParent;
      }
    }
    this.cache = {
      mode,
      matching,
      ancestors,
      deletedKeys,
      deletedCommandsByUri,
      deletedFilesByParent,
      deletedDirectoriesByParent,
    };
  }

  private isDeletedGhostDirectory(uri: vscode.Uri, mode: FilterMode): boolean {
    this.ensureCache(mode);
    for (const directories of this.cache?.deletedDirectoriesByParent?.values() ?? []) {
      if (directories.some((directory) => directory.toString() === uri.toString())) return true;
    }
    return false;
  }
}

/** 삭제 상태 표기를 공급자별 문자열 차이와 무관하게 판별한다. */
function isDeletedStatus(status: string | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase();
  return normalized === 'd' || normalized === 'deleted' || normalized === 'removed';
}

/** 부모 URI별 ghost 자식 목록에 중복 없이 URI를 추가한다. */
function appendUri(map: Map<string, vscode.Uri[]>, parent: vscode.Uri, child: vscode.Uri): void {
  const key = parent.toString();
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [child]);
    return;
  }
  if (!existing.some((uri) => uri.toString() === child.toString())) existing.push(child);
}

/** TreeItem이 CSS를 지원하지 않아 결합 취소선으로 삭제 파일의 시각 상태를 표현한다. */
function strikeThrough(value: string): string {
  return Array.from(value, (character) => `${character}\u0336`).join('');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatLineCount(lines: number): string {
  return `${lines} line${lines === 1 ? '' : 's'}`;
}

function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 10) lines++;
  }
  return bytes[bytes.length - 1] === 10 ? lines : lines + 1;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function deleteUriTreeEntries<T>(map: Map<string, T>, rootKey: string): void {
  for (const key of map.keys()) {
    if (isUriKeyInTree(rootKey, key)) map.delete(key);
  }
}

function isUriKeyInTree(rootKey: string, candidateKey: string): boolean {
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  return candidateKey === rootKey || candidateKey.startsWith(prefix);
}

async function readDropSources(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const internal = dataTransfer.get(INTERNAL_MIME);
  if (internal) {
    const value = internal.value;
    return Array.isArray(value) ? value.filter((x): x is vscode.Uri => x instanceof vscode.Uri) : [];
  }

  const external = dataTransfer.get('text/uri-list');
  if (!external) return [];
  const text = await external.asString();
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => {
      try {
        return vscode.Uri.parse(s);
      } catch {
        return undefined;
      }
    })
    .filter((u): u is vscode.Uri => u !== undefined);
}

function nodeUri(node: FileTreeNode): vscode.Uri | undefined {
  if (node instanceof WorkspaceFolderNode) return node.folder.uri;
  if (node instanceof DirectoryNode) return node.uri;
  if (node instanceof FileNode) return node.uri;
  return undefined;
}

async function resolveDropDestination(
  target: FileTreeNode | undefined,
): Promise<vscode.Uri | undefined> {
  if (target instanceof ExplorerErrorNode) return undefined;
  if (target instanceof WorkspaceFolderNode) return target.folder.uri;
  if (target instanceof DirectoryNode) return target.uri;
  if (target instanceof FileNode) return parentUri(target.uri);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri;
  return undefined;
}

function isInsideFolder(uri: vscode.Uri, folder: vscode.Uri): boolean {
  return isUriKeyInTree(folder.toString(), uri.toString());
}

function isSameOrAncestor(src: vscode.Uri, candidate: vscode.Uri): boolean {
  return isUriKeyInTree(src.toString(), candidate.toString());
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function fileExt(uri: vscode.Uri): string {
  const p = uri.path;
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  return dot > slash ? p.slice(dot + 1).toLowerCase() : '';
}

function makeCompareNodes(sort: SortState): (a: FileTreeNode, b: FileTreeNode) => number {
  const nameOrder: 1 | -1 = sort.name === 'desc' ? -1 : 1;
  const useType = sort.type;
  return (a, b) => {
    const aIsDir = a instanceof DirectoryNode ? 0 : 1;
    const bIsDir = b instanceof DirectoryNode ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;

    if (useType && aIsDir === 1 && bIsDir === 1) {
      const aExt = a instanceof FileNode ? fileExt(a.uri) : '';
      const bExt = b instanceof FileNode ? fileExt(b.uri) : '';
      if (aExt < bExt) return -1;
      if (aExt > bExt) return 1;
    }

    const aLabel = labelOf(a);
    const bLabel = labelOf(b);
    if (aLabel < bLabel) return -nameOrder;
    if (aLabel > bLabel) return nameOrder;
    return 0;
  };
}

function labelOf(node: FileTreeNode): string {
  if (node instanceof FileNode) return baseName(node.uri);
  const l = node.label;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && 'label' in l) return l.label;
  return '';
}
