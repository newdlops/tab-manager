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
    if (isDeleted) {
      this.description = 'deleted';
      this.contextValue = 'file.deleted';
      this.tooltip = `${uri.fsPath} (deleted)`;
    } else {
      this.contextValue = 'file';
      this.tooltip = uri.fsPath;
      this.command = {
        command: 'vscode.open',
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

export class ExplorerProvider implements vscode.TreeDataProvider<FileTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

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
