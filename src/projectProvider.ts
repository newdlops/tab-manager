import * as path from 'path';
import * as vscode from 'vscode';
import { formatOpenError } from './openResource';

export interface SavedProject {
  uri: vscode.Uri;
}

export interface RecentProject extends SavedProject {
  lastOpened: number;
}

export type ProjectSortMode = 'nameAsc' | 'nameDesc' | 'recent' | 'added';

const PROJECTS_KEY = 'tabManager.projects';
const RECENT_PROJECTS_KEY = 'tabManager.recentProjects';
const PROJECT_SORT_KEY = 'tabManager.projectSort';
const MAX_RECENT_PROJECTS = 40;

export class ProjectNode extends vscode.TreeItem {
  constructor(public readonly project: SavedProject) {
    super(projectLabel(project.uri), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = project.uri;
    this.description = projectCompactLocation(project.uri);
    this.tooltip = projectTooltip(project.uri);
    this.iconPath = isWorkspaceFile(project.uri)
      ? new vscode.ThemeIcon('workspace-trusted')
      : vscode.ThemeIcon.Folder;
    this.contextValue = 'project';
    this.id = `project:${project.uri.toString()}`;
    this.accessibilityInformation = {
      label: `${projectLabel(project.uri)}, ${projectFullLocation(project.uri)}, Open Project in New Window`,
      role: 'treeitem',
    };
    this.command = {
      command: 'tabManager.projects.open',
      title: 'Open Project in New Window',
      arguments: [this],
    };
  }
}

export class ProjectStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private cachedProjects?: SavedProject[];
  private cachedRecentProjects?: RecentProject[];
  private cachedSortMode?: ProjectSortMode;

  constructor(private readonly context: vscode.ExtensionContext) {
    void this.recordCurrentWorkspace();
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.recordCurrentWorkspace()),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.refreshFromStorage();
      }),
    );
  }

  refreshFromStorage(): void {
    const before = JSON.stringify({
      projects: this.cachedProjects?.map((project) => project.uri.toString()),
      recent: this.cachedRecentProjects?.map((project) => [project.uri.toString(), project.lastOpened]),
      sort: this.cachedSortMode,
    });
    this.cachedProjects = normalizeProjects(this.context.globalState.get<unknown>(PROJECTS_KEY));
    this.cachedRecentProjects = normalizeRecentProjects(this.context.globalState.get<unknown>(RECENT_PROJECTS_KEY));
    const storedSort = this.context.globalState.get<unknown>(PROJECT_SORT_KEY);
    this.cachedSortMode = isProjectSortMode(storedSort) ? storedSort : 'nameAsc';
    const after = JSON.stringify({
      projects: this.cachedProjects.map((project) => project.uri.toString()),
      recent: this.cachedRecentProjects.map((project) => [project.uri.toString(), project.lastOpened]),
      sort: this.cachedSortMode,
    });
    if (before !== after) this._onDidChange.fire();
  }

  getProjects(): SavedProject[] {
    if (!this.cachedProjects) {
      this.cachedProjects = normalizeProjects(this.context.globalState.get<unknown>(PROJECTS_KEY));
    }
    return this.cachedProjects;
  }

  getSortedProjects(): SavedProject[] {
    const projects = [...this.getProjects()];
    const mode = this.getSortMode();
    if (mode === 'added') return projects;
    const recent = mode === 'recent'
      ? new Map(this.getRecentProjects().map((project) => [project.uri.toString(), project.lastOpened]))
      : undefined;
    projects.sort((a, b) => {
      if (mode === 'recent') {
        const byTime = (recent?.get(b.uri.toString()) ?? 0) - (recent?.get(a.uri.toString()) ?? 0);
        if (byTime) return byTime;
      }
      const byName = projectLabel(a.uri).localeCompare(projectLabel(b.uri), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (byName) return mode === 'nameDesc' ? -byName : byName;
      return a.uri.toString().localeCompare(b.uri.toString());
    });
    return projects;
  }

  getRecentProjects(): RecentProject[] {
    if (!this.cachedRecentProjects) {
      this.cachedRecentProjects = normalizeRecentProjects(this.context.globalState.get<unknown>(RECENT_PROJECTS_KEY));
    }
    return this.cachedRecentProjects;
  }

  getSortMode(): ProjectSortMode {
    if (!this.cachedSortMode) {
      const stored = this.context.globalState.get<unknown>(PROJECT_SORT_KEY);
      this.cachedSortMode = isProjectSortMode(stored) ? stored : 'nameAsc';
    }
    return this.cachedSortMode;
  }

  async setSortMode(mode: ProjectSortMode): Promise<void> {
    if (mode === this.getSortMode()) return;
    this.cachedSortMode = mode;
    await this.persistGlobalState(PROJECT_SORT_KEY, mode);
    this._onDidChange.fire();
  }

  async recordCurrentWorkspace(): Promise<void> {
    await this.recordRecentProjects(currentWorkspaceProjectUris());
  }

  async recordRecentProjects(uris: readonly vscode.Uri[]): Promise<void> {
    if (uris.length === 0) return;
    const current = this.getRecentProjects();
    const unique = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
    const keys = new Set(unique.map((uri) => uri.toString()));
    const timestamp = Math.max(Date.now(), (current[0]?.lastOpened ?? 0) + 1);
    const next = [
      ...unique.map((uri) => ({ uri, lastOpened: timestamp })),
      ...current.filter((project) => !keys.has(project.uri.toString())),
    ].slice(0, MAX_RECENT_PROJECTS);
    this.cachedRecentProjects = next;
    await this.persistGlobalState(
      RECENT_PROJECTS_KEY,
      next.map((project) => ({ uri: project.uri.toString(), lastOpened: project.lastOpened })),
    );
    if (this.getSortMode() === 'recent') this._onDidChange.fire();
  }

  async forgetRecentProjects(uris: readonly vscode.Uri[]): Promise<void> {
    const keys = new Set(uris.map((uri) => uri.toString()));
    const next = this.getRecentProjects().filter((project) => !keys.has(project.uri.toString()));
    if (next.length === this.getRecentProjects().length) return;
    this.cachedRecentProjects = next;
    await this.persistGlobalState(
      RECENT_PROJECTS_KEY,
      next.length ? next.map((project) => ({ uri: project.uri.toString(), lastOpened: project.lastOpened })) : undefined,
    );
    if (this.getSortMode() === 'recent') this._onDidChange.fire();
  }

  async addProjects(uris: readonly vscode.Uri[]): Promise<number> {
    const current = this.getProjects();
    const seen = new Set(current.map((project) => project.uri.toString()));
    const next = [...current];
    let added = 0;

    for (const uri of uris) {
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ uri });
      added++;
    }

    if (added === 0) return 0;
    await this.setProjects(next);
    return added;
  }

  async removeProject(uri: vscode.Uri): Promise<void> {
    await this.removeProjects([uri]);
  }

  async removeProjects(uris: readonly vscode.Uri[]): Promise<void> {
    const keys = new Set(uris.map((uri) => uri.toString()));
    const next = this.getProjects().filter((project) => !keys.has(project.uri.toString()));
    if (next.length === this.getProjects().length) return;
    await this.setProjects(next);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private async setProjects(projects: SavedProject[]): Promise<void> {
    this.cachedProjects = projects;
    await this.persistGlobalState(
      PROJECTS_KEY,
      projects.length > 0 ? projects.map((project) => ({ uri: project.uri.toString() })) : undefined,
    );
    this._onDidChange.fire();
  }

  private async persistGlobalState(key: string, value: unknown): Promise<void> {
    try {
      await this.context.globalState.update(key, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(
        `Tab Manager could not save projects: ${message.replace(/^Error:\s*/, '')}`,
      );
    }
  }
}

export class ProjectProvider
  implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProjectNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly storeChange: vscode.Disposable;

  constructor(private readonly store: ProjectStore) {
    this.storeChange = store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProjectNode): ProjectNode[] {
    if (element) return [];
    return this.store.getSortedProjects().map((project) => new ProjectNode(project));
  }

  dispose(): void {
    this.storeChange.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

export function registerProjectCommands(
  context: vscode.ExtensionContext,
  store: ProjectStore,
  projectsView: vscode.TreeView<ProjectNode>,
): void {
  const selectedProject = (fallback?: ProjectNode): ProjectNode | undefined => {
    if (fallback) return fallback;
    return projectsView.selection[0];
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('tabManager.projects.open', async (node?: ProjectNode | vscode.Uri) => {
      const uri = node instanceof vscode.Uri ? node : node?.project.uri;
      if (!uri) return;
      if (await openProject(uri)) await store.recordRecentProjects([uri]);
    }),

    vscode.commands.registerCommand('tabManager.projects.addFolder', async () => {
      const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri,
        openLabel: 'Add Project',
        title: 'Add Project Folder',
      });
      if (!picks || picks.length === 0) return;
      await addExistingProjects(store, picks);
    }),

    vscode.commands.registerCommand('tabManager.projects.addCurrentWorkspace', async () => {
      const uris = currentWorkspaceProjectUris();
      if (uris.length === 0) {
        vscode.window.showInformationMessage('Open a folder or workspace before adding a project.');
        return;
      }
      await addExistingProjects(store, uris);
    }),

    vscode.commands.registerCommand('tabManager.projects.remove', async (node?: ProjectNode) => {
      const project = selectedProject(node);
      if (!project) return;
      await store.removeProject(project.project.uri);
    }),

    vscode.commands.registerCommand('tabManager.projects.addRecent', async () => {
      const recent = store.getRecentProjects();
      const saved = new Set(store.getProjects().map((project) => project.uri.toString()));
      const available = recent.filter((project) => !saved.has(project.uri.toString()));
      if (available.length === 0) {
        const action = await vscode.window.showInformationMessage(
          recent.length > 0
            ? 'All recently seen projects are already saved.'
            : 'No recent projects yet. Open a folder or workspace in VS Code to see it here.',
          'Open VS Code Recent',
        );
        if (action) await vscode.commands.executeCommand('workbench.action.openRecent');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        available.map((project) => ({
          label: projectLabel(project.uri),
          description: projectFullLocation(project.uri),
          project,
        })),
        { canPickMany: true, title: 'Add Recent Projects', placeHolder: 'Select folders or workspaces to save' },
      );
      if (picks?.length) await addExistingProjects(store, picks.map((pick) => pick.project.uri));
    }),

    vscode.commands.registerCommand('tabManager.projects.sort', async () => {
      const options: { mode: ProjectSortMode; label: string }[] = [
        { mode: 'nameAsc', label: 'Name A–Z' },
        { mode: 'nameDesc', label: 'Name Z–A' },
        { mode: 'recent', label: 'Recently Opened' },
        { mode: 'added', label: 'Added Order' },
      ];
      const current = store.getSortMode();
      const pick = await vscode.window.showQuickPick(
        options.map((option) => ({
          label: option.label,
          description: option.mode === current ? 'Current' : undefined,
          mode: option.mode,
        })),
        { title: 'Sort Projects', placeHolder: 'Choose project order' },
      );
      if (pick) await store.setSortMode(pick.mode);
    }),

    vscode.commands.registerCommand('tabManager.projects.removeMany', async () => {
      const projects = store.getSortedProjects();
      if (projects.length === 0) {
        void vscode.window.showInformationMessage('No saved projects to remove.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        projects.map((project) => ({
          label: projectLabel(project.uri),
          description: projectFullLocation(project.uri),
          project,
        })),
        { canPickMany: true, title: 'Remove Saved Projects', placeHolder: 'Select projects to remove from Tab Manager' },
      );
      if (picks?.length) await store.removeProjects(picks.map((pick) => pick.project.uri));
    }),

    vscode.commands.registerCommand('tabManager.projects.forgetRecent', async () => {
      const projects = store.getRecentProjects();
      if (projects.length === 0) {
        void vscode.window.showInformationMessage('No recent projects to forget.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        projects.map((project) => ({
          label: projectLabel(project.uri),
          description: projectFullLocation(project.uri),
          project,
        })),
        { canPickMany: true, title: 'Forget Recent Projects', placeHolder: 'Select recent projects to forget' },
      );
      if (picks?.length) await store.forgetRecentProjects(picks.map((pick) => pick.project.uri));
    }),
  );
}

async function openProject(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('vscode.openFolder', uri, true);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to open project "${projectLabel(uri)}": ${formatOpenError(error)}`,
    );
    return false;
  }
}

async function addExistingProjects(
  store: ProjectStore,
  uris: readonly vscode.Uri[],
): Promise<void> {
  const valid: vscode.Uri[] = [];
  const invalid: vscode.Uri[] = [];
  for (let start = 0; start < uris.length; start += 4) {
    const batch = uris.slice(start, start + 4);
    const results = await Promise.all(batch.map(isProjectUri));
    for (const [index, uri] of batch.entries()) {
      if (results[index]) {
        valid.push(uri);
      } else {
        invalid.push(uri);
      }
    }
  }
  if (invalid.length > 0) {
    const locations = invalid.slice(0, 3).map((uri) => `"${projectFullLocation(uri)}"`).join(', ');
    const remainder = invalid.length > 3 ? ` and ${invalid.length - 3} more` : '';
    void vscode.window.showWarningMessage(
      `${invalid.length} selected project${invalid.length === 1 ? '' : 's'} could not be added: ${locations}${remainder}.`,
    );
  }
  if (valid.length === 0) return;
  await store.addProjects(valid);
}

async function isProjectUri(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return !!(stat.type & vscode.FileType.Directory) || (isWorkspaceFile(uri) && !!(stat.type & vscode.FileType.File));
  } catch {
    return false;
  }
}

function currentWorkspaceProjectUris(): vscode.Uri[] {
  if (vscode.workspace.workspaceFile && isWorkspaceFile(vscode.workspace.workspaceFile)) {
    return [vscode.workspace.workspaceFile];
  }
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
}

function isProjectSortMode(value: unknown): value is ProjectSortMode {
  return value === 'nameAsc' || value === 'nameDesc' || value === 'recent' || value === 'added';
}

function normalizeRecentProjects(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return [];
  const projects: RecentProject[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { uri: value, lastOpened } = item as { uri?: unknown; lastOpened?: unknown };
    if (typeof value !== 'string' || !value || typeof lastOpened !== 'number' || !Number.isFinite(lastOpened)) continue;
    try {
      const uri = vscode.Uri.parse(value);
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ uri, lastOpened });
    } catch {
      continue;
    }
  }
  return projects.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, MAX_RECENT_PROJECTS);
}

function normalizeProjects(raw: unknown): SavedProject[] {
  if (!Array.isArray(raw)) return [];
  const projects: SavedProject[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const uriValue = (item as { uri?: unknown }).uri;
    if (typeof uriValue !== 'string' || !uriValue) continue;
    try {
      const uri = vscode.Uri.parse(uriValue);
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ uri });
    } catch {
      continue;
    }
  }
  return projects;
}

function projectLabel(uri: vscode.Uri): string {
  const basename = path.posix.basename(uri.path);
  if (isWorkspaceFile(uri)) return basename.replace(/\.code-workspace$/i, '') || basename;
  return basename || uri.fsPath || uri.toString();
}

function projectFullLocation(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function projectCompactLocation(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') return uri.authority || uri.scheme;
  const parent = path.dirname(uri.fsPath);
  return path.basename(parent) || parent;
}

function projectTooltip(uri: vscode.Uri): string {
  return `${projectLabel(uri)}\n${projectFullLocation(uri)}\nOpen Project in New Window`;
}

function isWorkspaceFile(uri: vscode.Uri): boolean {
  return path.posix.basename(uri.path).toLowerCase().endsWith('.code-workspace');
}
