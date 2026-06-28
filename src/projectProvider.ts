import * as path from 'path';
import * as vscode from 'vscode';
import { formatOpenError } from './openResource';

export interface SavedProject {
  uri: vscode.Uri;
}

const PROJECTS_KEY = 'tabManager.projects';

export class ProjectNode extends vscode.TreeItem {
  constructor(public readonly project: SavedProject) {
    super(projectLabel(project.uri), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = project.uri;
    this.description = projectDescription(project.uri);
    this.tooltip = projectTooltip(project.uri);
    this.iconPath = isWorkspaceFile(project.uri)
      ? new vscode.ThemeIcon('workspace-trusted')
      : vscode.ThemeIcon.Folder;
    this.contextValue = 'project';
    this.id = `project:${project.uri.toString()}`;
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  getProjects(): SavedProject[] {
    if (!this.cachedProjects) {
      this.cachedProjects = normalizeProjects(this.context.globalState.get<unknown>(PROJECTS_KEY));
    }
    return this.cachedProjects;
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
    const key = uri.toString();
    const next = this.getProjects().filter((project) => project.uri.toString() !== key);
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
    return this.store.getProjects().map((project) => new ProjectNode(project));
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
      await openProject(uri);
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
  );
}

async function openProject(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.openFolder', uri, true);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to open project "${projectLabel(uri)}": ${formatOpenError(error)}`,
    );
  }
}

async function addExistingProjects(
  store: ProjectStore,
  uris: readonly vscode.Uri[],
): Promise<void> {
  const valid: vscode.Uri[] = [];
  for (const uri of uris) {
    if (await isProjectUri(uri)) {
      valid.push(uri);
    } else {
      vscode.window.showWarningMessage(`"${projectDescription(uri)}" is not a folder or VS Code workspace file.`);
    }
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
  if (vscode.workspace.workspaceFile) return [vscode.workspace.workspaceFile];
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
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

function projectDescription(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function projectTooltip(uri: vscode.Uri): string {
  return `${projectLabel(uri)}\n${projectDescription(uri)}`;
}

function isWorkspaceFile(uri: vscode.Uri): boolean {
  return path.posix.basename(uri.path).toLowerCase().endsWith('.code-workspace');
}
