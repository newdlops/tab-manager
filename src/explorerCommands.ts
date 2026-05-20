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
import { formatOpenError, openResource } from './openResource';
import { isVsixFileName } from './util';

type AnyNode = FileTreeNode;
type AnyItem = vscode.TreeItem;

interface ClipboardState {
  mode: 'cut' | 'copy';
  uris: vscode.Uri[];
}

let clipboard: ClipboardState | undefined;
let compareLeft: vscode.Uri | undefined;

export function registerExplorerCommands(
  context: vscode.ExtensionContext,
  provider: ExplorerProvider,
  filesView: vscode.TreeView<FileTreeNode>,
  filterSource: FilterSource,
): void {
  const selectedItems = (
    fallback?: AnyItem,
    items?: readonly AnyItem[],
  ): AnyItem[] => {
    if (items && items.length > 0) return [...items];
    if (fallback) return [fallback];
    return [...filesView.selection];
  };
  const selectedNodes = (fallback?: AnyNode): AnyNode[] => {
    const sel = filesView.selection;
    if (sel.length > 0) return [...sel];
    return fallback ? [fallback] : [];
  };
  const selectedUris = (
    fallback?: AnyItem,
    items?: readonly AnyItem[],
  ): vscode.Uri[] => {
    return selectedItems(fallback, items)
      .map(uriOf)
      .filter((u): u is vscode.Uri => u !== undefined);
  };

  const updateClipboardContext = () => {
    void vscode.commands.executeCommand(
      'setContext',
      'tabManager.explorerHasClipboard',
      !!clipboard,
    );
  };
  const updateCompareContext = () => {
    void vscode.commands.executeCommand(
      'setContext',
      'tabManager.explorerHasCompareLeft',
      !!compareLeft,
    );
  };
  updateClipboardContext();
  updateCompareContext();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'tabManager.explorer.open',
      async (node?: AnyItem | vscode.Uri) => {
        const uri = node instanceof vscode.Uri ? node : selectedUris(node)[0];
        if (!uri) return;
        await openExplorerResource(provider, uri);
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.refresh', async () => {
      try {
        await filterSource.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to refresh Explorer: ${formatOpenError(error)}`);
      } finally {
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand('tabManager.explorer.newFile', (node?: AnyNode) =>
      startInlineCreate(provider, filesView, node, 'file'),
    ),

    vscode.commands.registerCommand('tabManager.explorer.newFolder', (node?: AnyNode) =>
      startInlineCreate(provider, filesView, node, 'folder'),
    ),

    vscode.commands.registerCommand(
      'tabManager.explorer.rename',
      async (node?: AnyItem, items?: AnyItem[]) => {
        const target = node ?? selectedItems(undefined, items)[0];
        const oldUri = uriOf(target);
        if (!oldUri || !isModifiable(oldUri)) return;
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
        const validation = validateName(trimmed);
        if (validation) {
          vscode.window.showErrorMessage(validation);
          return;
        }
        const newUri = vscode.Uri.joinPath(parentUri(oldUri), trimmed);
        if (await exists(newUri)) {
          vscode.window.showErrorMessage(`"${trimmed}" already exists.`);
          return;
        }
        try {
          await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
        } catch (e) {
          provider.invalidateDirectory(parentUri(oldUri));
          provider.refresh();
          vscode.window.showErrorMessage(`Failed to rename ${current}: ${formatOpenError(e)}`);
        }
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.delete', async (node?: AnyItem, items?: AnyItem[]) => {
      const targets = selectedUris(node, items).filter((u) => isModifiable(u));
      if (targets.length === 0) return;
      const detail =
        targets.length === 1
          ? `"${baseName(targets[0])}" will be moved to the Trash.`
          : `${targets.length} items will be moved to the Trash.`;
      const message =
        targets.length === 1 ? `Delete "${baseName(targets[0])}"?` : `Delete ${targets.length} items?`;
      const pick = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        'Delete',
      );
      if (pick !== 'Delete') return;
      for (const uri of targets) {
        try {
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to delete ${baseName(uri)}: ${String(e)}`);
        }
      }
    }),

    vscode.commands.registerCommand('tabManager.explorer.copyPath', async (node?: AnyItem, items?: AnyItem[]) => {
      const uris = selectedUris(node, items);
      if (uris.length === 0) return;
      await runOrShowError('Failed to copy path', () =>
        vscode.env.clipboard.writeText(uris.map((u) => u.fsPath).join('\n')),
      );
    }),

    vscode.commands.registerCommand(
      'tabManager.explorer.copyRelativePath',
      async (node?: AnyItem, items?: AnyItem[]) => {
        const uris = selectedUris(node, items);
        if (uris.length === 0) return;
        await runOrShowError('Failed to copy relative path', () =>
          vscode.env.clipboard.writeText(
            uris.map((u) => vscode.workspace.asRelativePath(u, false)).join('\n'),
          ),
        );
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.revealInOS', async (node?: AnyItem, items?: AnyItem[]) => {
      const uri = selectedUris(node, items)[0];
      if (!uri) return;
      await runUriCommand(provider, uri, `Failed to reveal "${baseName(uri)}"`, () =>
        vscode.commands.executeCommand('revealFileInOS', uri),
      );
    }),

    vscode.commands.registerCommand(
      'tabManager.explorer.openInTerminal',
      async (node?: AnyNode) => {
        const uri = selectedUris(node)[0];
        if (!uri) return;
        await runUriCommand(provider, uri, `Failed to open terminal in "${baseName(uri)}"`, () => {
          const terminal = vscode.window.createTerminal({
            cwd: uri,
            name: baseName(uri) || uri.fsPath,
          });
          terminal.show();
        });
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.openToSide', async (node?: AnyItem, items?: AnyItem[]) => {
      const uris = selectedUris(node, items).filter(
        (u, i, arr) => arr.findIndex((v) => v.toString() === u.toString()) === i,
      );
      for (const uri of uris) {
        await openExplorerResource(provider, uri, { viewColumn: vscode.ViewColumn.Beside });
      }
    }),

    vscode.commands.registerCommand('tabManager.explorer.openWith', async (node?: AnyItem, items?: AnyItem[]) => {
      const uri = selectedUris(node, items)[0];
      if (!uri) return;
      await runUriCommand(provider, uri, `Failed to open "${baseName(uri)}" with another editor`, () =>
        vscode.commands.executeCommand('explorer.openWith', uri),
      );
    }),

    vscode.commands.registerCommand(
      'tabManager.explorer.installVsix',
      async (node?: AnyItem, items?: AnyItem[]) => {
        const uris = selectedUris(node, items).filter(isVsixFile);
        if (uris.length === 0) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${uris.length === 1 ? baseName(uris[0]) : `${uris.length} VSIX files`}`,
            cancellable: false,
          },
          async () => {
            for (const uri of uris) {
              try {
                await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
              } catch (error) {
                vscode.window.showErrorMessage(
                  `Failed to install "${baseName(uri)}": ${formatOpenError(error)}`,
                );
              }
            }
          },
        );
      },
    ),

    vscode.commands.registerCommand(
      'tabManager.explorer.findInFolder',
      async (node?: AnyNode) => {
        const uri = selectedUris(node)[0];
        if (!uri) return;
        const rel = vscode.workspace.asRelativePath(uri, false);
        await runUriCommand(provider, uri, `Failed to search in "${baseName(uri)}"`, () =>
          vscode.commands.executeCommand('workbench.action.findInFiles', {
            filesToInclude: rel,
            triggerSearch: false,
          }),
        );
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.cut', async (node?: AnyItem, items?: AnyItem[]) => {
      const uris = selectedUris(node, items).filter(isModifiable);
      if (uris.length === 0) return;
      clipboard = { mode: 'cut', uris };
      updateClipboardContext();
    }),

    vscode.commands.registerCommand('tabManager.explorer.copy', async (node?: AnyItem, items?: AnyItem[]) => {
      const uris = selectedUris(node, items);
      if (uris.length === 0) return;
      clipboard = { mode: 'copy', uris };
      updateClipboardContext();
    }),

    vscode.commands.registerCommand('tabManager.explorer.paste', async (node?: AnyNode) => {
      if (!clipboard || clipboard.uris.length === 0) return;
      const target = await resolveContainer(node ?? selectedNodes()[0]);
      if (!target) return;
      const move = clipboard.mode === 'cut';
      const sources = clipboard.uris;

      for (const src of sources) {
        const name = baseName(src);
        if (isSameOrAncestor(src, target)) {
          vscode.window.showWarningMessage(`Cannot ${move ? 'move' : 'copy'} "${name}" into itself.`);
          continue;
        }
        let destUri = vscode.Uri.joinPath(target, name);
        if (src.toString() === destUri.toString()) {
          if (move) continue;
          destUri = await uniqueDestination(target, name);
        } else if (await exists(destUri)) {
          if (move) {
            const pick = await vscode.window.showWarningMessage(
              `"${name}" already exists. Overwrite?`,
              { modal: true },
              'Overwrite',
              'Skip',
            );
            if (pick !== 'Overwrite') continue;
          } else {
            destUri = await uniqueDestination(target, name);
          }
        }
        try {
          if (move) {
            await vscode.workspace.fs.rename(src, destUri, { overwrite: true });
          } else {
            await vscode.workspace.fs.copy(src, destUri, { overwrite: true });
          }
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to ${move ? 'move' : 'copy'} ${name}: ${String(e)}`);
        }
      }

      if (move) {
        clipboard = undefined;
        updateClipboardContext();
      }
    }),

    vscode.commands.registerCommand(
      'tabManager.explorer.selectForCompare',
      async (node?: AnyItem, items?: AnyItem[]) => {
        const uri = selectedUris(node, items)[0];
        if (!uri) return;
        compareLeft = uri;
        updateCompareContext();
      },
    ),

    vscode.commands.registerCommand(
      'tabManager.explorer.compareWithSelected',
      async (node?: AnyItem, items?: AnyItem[]) => {
        const right = selectedUris(node, items)[0];
        if (!right || !compareLeft) return;
        const left = compareLeft;
        await runUriCommand(
          provider,
          [left, right],
          `Failed to compare "${baseName(left)}" and "${baseName(right)}"`,
          () =>
            vscode.commands.executeCommand(
              'vscode.diff',
              left,
              right,
              `${baseName(left)} ↔ ${baseName(right)}`,
            ),
        );
      },
    ),

    vscode.commands.registerCommand('tabManager.explorer.compareSelected', async (node?: AnyItem, items?: AnyItem[]) => {
      const uris = selectedUris(node, items).filter(
        (u, i, arr) => arr.findIndex((v) => v.toString() === u.toString()) === i,
      );
      if (uris.length !== 2) {
        vscode.window.showInformationMessage('Select exactly two files to compare.');
        return;
      }
      await runUriCommand(
        provider,
        uris,
        `Failed to compare "${baseName(uris[0])}" and "${baseName(uris[1])}"`,
        () =>
          vscode.commands.executeCommand(
            'vscode.diff',
            uris[0],
            uris[1],
            `${baseName(uris[0])} ↔ ${baseName(uris[1])}`,
          ),
      );
    }),
  );
}

async function openExplorerResource(
  provider: ExplorerProvider,
  uri: vscode.Uri,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
  try {
    await openResource(uri, options);
  } catch (error) {
    provider.invalidateDirectory(parentUri(uri));
    provider.refresh();
    vscode.window.showErrorMessage(`Failed to open "${baseName(uri)}": ${formatOpenError(error)}`);
  }
}

async function runUriCommand(
  provider: ExplorerProvider,
  uris: vscode.Uri | readonly vscode.Uri[],
  failureMessage: string,
  run: () => unknown | Thenable<unknown>,
): Promise<void> {
  try {
    await Promise.resolve(run());
  } catch (error) {
    invalidateUris(provider, Array.isArray(uris) ? uris : [uris]);
    vscode.window.showErrorMessage(`${failureMessage}: ${formatOpenError(error)}`);
  }
}

async function runOrShowError(
  failureMessage: string,
  run: () => unknown | Thenable<unknown>,
): Promise<void> {
  try {
    await Promise.resolve(run());
  } catch (error) {
    vscode.window.showErrorMessage(`${failureMessage}: ${formatOpenError(error)}`);
  }
}

function invalidateUris(provider: ExplorerProvider, uris: readonly vscode.Uri[]): void {
  for (const uri of uris) provider.invalidateDirectory(parentUri(uri));
  provider.refresh();
}

async function startInlineCreate(
  provider: ExplorerProvider,
  filesView: vscode.TreeView<FileTreeNode>,
  triggerNode: AnyNode | undefined,
  kind: PendingKind,
): Promise<void> {
  const dir = await resolveContainer(triggerNode ?? filesView.selection[0]);
  if (!dir) return;

  const reveal = triggerNode ?? filesView.selection[0];
  if (reveal && !(reveal instanceof PendingNode)) {
    try {
      await filesView.reveal(reveal, { expand: true, select: false, focus: false });
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
          await openExplorerResource(provider, target);
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

function uriOf(node: AnyItem | undefined): vscode.Uri | undefined {
  if (!node) return undefined;
  if (node instanceof WorkspaceFolderNode) return node.folder.uri;
  if (node instanceof DirectoryNode) return node.uri;
  if (node instanceof FileNode) return node.uri;
  return node.resourceUri;
}

function isModifiable(uri: vscode.Uri): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return !folders.some((f) => f.uri.toString() === uri.toString());
}

function isVsixFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && isVsixFileName(baseName(uri));
}

function isSameOrAncestor(src: vscode.Uri, candidate: vscode.Uri): boolean {
  const s = src.toString();
  const c = candidate.toString();
  return s === c || c.startsWith(s + '/');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function uniqueDestination(parent: vscode.Uri, name: string): Promise<vscode.Uri> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = vscode.Uri.joinPath(parent, `${stem} copy${i === 1 ? '' : ' ' + i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  return vscode.Uri.joinPath(parent, `${stem}-${Date.now()}${ext}`);
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
