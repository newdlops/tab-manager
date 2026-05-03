import * as vscode from 'vscode';
import * as path from 'path';
import type { GroupStore, FilterMode, SortState } from './groupStore';
import type { FilterSource } from './filterSource';

export type FileTreeNode = WorkspaceFolderNode | DirectoryNode | FileNode | PendingNode;
export type PendingKind = 'file' | 'folder';

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

export class FileNode extends vscode.TreeItem {
  constructor(public readonly uri: vscode.Uri, public readonly isDeleted = false) {
    super(baseName(uri), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.id = `file:${isDeleted ? 'deleted:' : ''}${uri.toString()}`;
    if (isDeleted) {
      this.description = 'deleted';
      this.contextValue = 'file.deleted';
      this.tooltip = `${uri.fsPath} (deleted)`;
    } else {
      this.contextValue = 'file';
      this.tooltip = uri.fsPath;
      this.command = {
        command: 'tabManager.explorer.open',
        title: 'Open',
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

export class ExplorerProvider
  implements vscode.TreeDataProvider<FileTreeNode>, vscode.TreeDragAndDropController<FileTreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dropMimeTypes = [INTERNAL_MIME, 'text/uri-list'];
  readonly dragMimeTypes = ['text/uri-list'];

  private cache?: { mode: FilterMode; matching: Set<string>; ancestors: Set<string> };
  private readonly dirCache = new Map<string, [string, vscode.FileType][]>();
  private pending?: { parentUri: vscode.Uri; kind: PendingKind; name: string };

  constructor(
    private readonly store: GroupStore,
    private readonly filter: FilterSource,
  ) {
    store.onDidChange(() => this.refreshFilter());
    filter.onDidChange(() => this.refreshFilter());
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
    const internal = dataTransfer.get(INTERNAL_MIME);
    if (internal) {
      const v = internal.value;
      if (Array.isArray(v)) sources = v.filter((x): x is vscode.Uri => x instanceof vscode.Uri);
    } else {
      const external = dataTransfer.get('text/uri-list');
      if (external) {
        const text = await external.asString();
        sources = text
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
        vscode.window.showErrorMessage(`Failed to move ${name}: ${String(e)}`);
      }
    }
  }

  refresh(): void {
    this.cache = undefined;
    this.dirCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  private refreshFilter(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  invalidateDirectory(uri: vscode.Uri): void {
    this.dirCache.delete(uri.toString());
  }

  startPending(parentUri: vscode.Uri, kind: PendingKind): void {
    this.pending = { parentUri, kind, name: '' };
    this.invalidateDirectory(parentUri);
    this._onDidChangeTreeData.fire(undefined);
  }

  updatePendingName(name: string): void {
    if (!this.pending) return;
    this.pending.name = name;
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPending(): void {
    if (!this.pending) return;
    const parent = this.pending.parentUri;
    this.pending = undefined;
    this.invalidateDirectory(parent);
    this._onDidChangeTreeData.fire(undefined);
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
    const uri = element instanceof DirectoryNode ? element.uri : element.uri;
    const parent = parentUri(uri);
    if (parent.toString() === uri.toString()) return undefined;

    const folders = vscode.workspace.workspaceFolders ?? [];
    const matchingFolder = folders.find((f) => f.uri.toString() === parent.toString());
    if (matchingFolder) {
      return folders.length === 1 ? undefined : new WorkspaceFolderNode(matchingFolder);
    }
    return new DirectoryNode(parent);
  }

  nodeForUri(uri: vscode.Uri): FileTreeNode | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const containing = folders.find((f) => isInsideFolder(uri, f.uri));
    if (!containing) return undefined;
    if (uri.toString() === containing.uri.toString()) {
      return folders.length === 1 ? undefined : new WorkspaceFolderNode(containing);
    }
    return new FileNode(uri);
  }

  async getChildren(element?: FileTreeNode): Promise<FileTreeNode[]> {
    const mode = this.store.getFilterMode();

    if (!element) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return [];
      if (folders.length === 1) return this.readDirectory(folders[0].uri, mode);
      return folders.map((f) => new WorkspaceFolderNode(f));
    }
    if (element instanceof WorkspaceFolderNode) {
      return this.readDirectory(element.folder.uri, mode);
    }
    if (element instanceof DirectoryNode) {
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
      } catch {
        return [];
      }
      this.dirCache.set(cacheKey, entries);
    }

    this.ensureCache(mode);
    const matching = this.cache!.matching;
    const ancestors = this.cache!.ancestors;

    const nodes: FileTreeNode[] = [];
    for (const [name, type] of entries) {
      const uri = vscode.Uri.joinPath(folder, name);
      const key = uri.toString();
      if (type & vscode.FileType.Directory) {
        if (mode === 'none' || ancestors.has(key)) {
          nodes.push(new DirectoryNode(uri, this.isPendingAncestor(uri)));
        }
      } else if (type & vscode.FileType.File) {
        if (mode === 'none' || matching.has(key)) nodes.push(new FileNode(uri));
      }
    }

    if (mode === 'deleted') {
      const deleted = this.filter.getUris('deleted');
      const folderKey = folder.toString();
      for (const du of deleted) {
        if (parentUri(du).toString() === folderKey) nodes.push(new FileNode(du, true));
      }
    }

    nodes.sort(makeCompareNodes(this.store.getSortState()));

    if (this.pending && this.isPendingAt(folder)) {
      nodes.unshift(new PendingNode(this.pending.kind, this.pending.name));
    }

    return nodes;
  }

  private ensureCache(mode: FilterMode): void {
    if (this.cache?.mode === mode) return;
    if (mode === 'none') {
      this.cache = { mode, matching: new Set(), ancestors: new Set() };
      return;
    }
    const uris = this.filter.getUris(mode);
    const matching = new Set(uris.map((u) => u.toString()));
    const ancestors = new Set<string>();
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
    this.cache = { mode, matching, ancestors };
  }
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
  if (target instanceof WorkspaceFolderNode) return target.folder.uri;
  if (target instanceof DirectoryNode) return target.uri;
  if (target instanceof FileNode) return parentUri(target.uri);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri;
  return undefined;
}

function isInsideFolder(uri: vscode.Uri, folder: vscode.Uri): boolean {
  const u = uri.toString();
  const f = folder.toString();
  return u === f || u.startsWith(f + '/');
}

function isSameOrAncestor(src: vscode.Uri, candidate: vscode.Uri): boolean {
  const s = src.toString();
  const c = candidate.toString();
  if (s === c) return true;
  return c.startsWith(s + '/');
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
  const l = node.label;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && 'label' in l) return l.label;
  return '';
}
