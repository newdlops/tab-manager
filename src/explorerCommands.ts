import * as vscode from 'vscode';
import {
  DirectoryNode,
  FileNode,
  PendingNode,
  WorkspaceFolderNode,
  baseName,
  parentUri,
  type ExplorerProvider,
  type FileTreeNode,
  type PendingKind,
} from './explorerProvider';
import type { FilterSource } from './filterSource';

type AnyNode = FileTreeNode;

export function registerExplorerCommands(
  context: vscode.ExtensionContext,
  provider: ExplorerProvider,
  filesView: vscode.TreeView<FileTreeNode>,
  filterSource: FilterSource,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tabManager.explorer.refresh', async () => {
      await filterSource.refresh();
      provider.refresh();
    }),

    vscode.commands.registerCommand('tabManager.explorer.newFile', (node?: AnyNode) =>
      startInlineCreate(provider, filesView, node, 'file'),
    ),

    vscode.commands.registerCommand('tabManager.explorer.newFolder', (node?: AnyNode) =>
      startInlineCreate(provider, filesView, node, 'folder'),
    ),

    vscode.commands.registerCommand(
      'tabManager.explorer.rename',
      async (node: FileNode | DirectoryNode) => {
        const oldUri = node.uri;
        const current = baseName(oldUri);
        const name = await vscode.window.showInputBox({
          prompt: 'New name',
          value: current,
          valueSelection: [
            0,
            current.lastIndexOf('.') > 0 ? current.lastIndexOf('.') : current.length,
          ],
        });
        const trimmed = name?.trim();
        if (!trimmed || trimmed === current) return;
        const newUri = vscode.Uri.joinPath(parentUri(oldUri), trimmed);
        if (await exists(newUri)) {
          vscode.window.showErrorMessage(`"${trimmed}" already exists.`);
          return;
        }
        await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
      },
    ),

    vscode.commands.registerCommand(
      'tabManager.explorer.delete',
      async (node: FileNode | DirectoryNode) => {
        const name = baseName(node.uri);
        const pick = await vscode.window.showWarningMessage(
          `Delete "${name}"?`,
          { modal: true, detail: 'The item will be moved to the Trash.' },
          'Delete',
        );
        if (pick !== 'Delete') return;
        await vscode.workspace.fs.delete(node.uri, { recursive: true, useTrash: true });
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.copyPath', async (node: AnyNode) => {
      const uri = uriOf(node);
      if (!uri) return;
      await vscode.env.clipboard.writeText(uri.fsPath);
    }),

    vscode.commands.registerCommand(
      'tabManager.explorer.copyRelativePath',
      async (node: AnyNode) => {
        const uri = uriOf(node);
        if (!uri) return;
        await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(uri, false));
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.revealInOS', async (node: AnyNode) => {
      const uri = uriOf(node);
      if (!uri) return;
      await vscode.commands.executeCommand('revealFileInOS', uri);
    }),

    vscode.commands.registerCommand(
      'tabManager.explorer.openInTerminal',
      async (node: WorkspaceFolderNode | DirectoryNode) => {
        const uri = uriOf(node);
        if (!uri) return;
        const terminal = vscode.window.createTerminal({
          cwd: uri,
          name: baseName(uri) || uri.fsPath,
        });
        terminal.show();
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.openToSide', async (node: FileNode) => {
      await vscode.commands.executeCommand('vscode.open', node.uri, vscode.ViewColumn.Beside);
    }),
  );
}

async function startInlineCreate(
  provider: ExplorerProvider,
  filesView: vscode.TreeView<FileTreeNode>,
  triggerNode: AnyNode | undefined,
  kind: PendingKind,
): Promise<void> {
  const dir = await resolveContainer(triggerNode);
  if (!dir) return;

  if (triggerNode && !(triggerNode instanceof PendingNode)) {
    try {
      await filesView.reveal(triggerNode, { expand: true, select: false, focus: false });
    } catch {
      /* element may be stale — isPendingAncestor handles expansion as fallback */
    }
  }

  provider.startPending(dir, kind);

  const input = vscode.window.createInputBox();
  input.title = `New ${kind === 'file' ? 'File' : 'Folder'}`;
  input.placeholder = kind === 'file' ? 'example.ts' : 'components';
  input.prompt = `Create ${kind} in ${vscode.workspace.asRelativePath(dir, true)}`;
  input.ignoreFocusOut = true;

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    input.onDidChangeValue((value) => {
      provider.updatePendingName(value);
      const msg = validateName(value);
      input.validationMessage = msg;
    }),
    input.onDidAccept(async () => {
      const name = input.value.trim();
      if (!name) {
        input.hide();
        return;
      }
      if (validateName(name)) return;
      const target = vscode.Uri.joinPath(dir, name);
      if (await exists(target)) {
        input.validationMessage = `"${name}" already exists.`;
        return;
      }
      input.hide();
      try {
        if (kind === 'file') {
          await vscode.workspace.fs.writeFile(target, new Uint8Array());
          await vscode.window.showTextDocument(target);
        } else {
          await vscode.workspace.fs.createDirectory(target);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to create ${kind}: ${String(e)}`);
      }
    }),
    input.onDidHide(() => {
      provider.clearPending();
      for (const d of disposables) d.dispose();
      input.dispose();
    }),
  );

  input.show();
}

function validateName(value: string): string | undefined {
  if (!value) return undefined;
  if (/[\\/]/.test(value)) return 'Name cannot contain / or \\';
  if (value === '.' || value === '..') return 'Invalid name';
  if (value.trim() !== value) return 'Name cannot start or end with whitespace';
  return undefined;
}

function uriOf(node: AnyNode): vscode.Uri | undefined {
  if (node instanceof WorkspaceFolderNode) return node.folder.uri;
  if (node instanceof DirectoryNode) return node.uri;
  if (node instanceof FileNode) return node.uri;
  return undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function resolveContainer(node?: AnyNode): Promise<vscode.Uri | undefined> {
  if (node) {
    if (node instanceof WorkspaceFolderNode) return node.folder.uri;
    if (node instanceof DirectoryNode) return node.uri;
    if (node instanceof FileNode) return parentUri(node.uri);
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage('No workspace folder is open.');
    return undefined;
  }
  if (folders.length === 1) return folders[0].uri;
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, uri: f.uri })),
    { placeHolder: 'Select a workspace folder' },
  );
  return pick?.uri;
}
