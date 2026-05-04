import * as vscode from 'vscode';

const OPEN_EDITOR_ERROR = 'Could NOT open editor for';
const RETRY_DELAY_MS = 75;
const INTERNAL_EDITOR_CONTROL_ERRORS = [
  'hasWidgetFocus is not a function',
  'hasModel is not a function',
  'removeDecorationsByType is not a function',
];

export async function openResource(
  uri: vscode.Uri,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
  await retryTransientOpenFailure(() => executeOpen(uri, options));
}

export function formatOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isInternalEditorControlError(error)) {
    return 'VS Code hit an internal editor focus error while switching editors.';
  }
  if (message.includes(OPEN_EDITOR_ERROR)) {
    return 'VS Code could not create an editor for this resource.';
  }
  return message.replace(/^Error:\s*/, '') || 'Unknown error';
}

async function executeOpen(
  uri: vscode.Uri,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
  // Prefer the typed showTextDocument API. The `vscode.open` command path can
  // throw "hasWidgetFocus is not a function" when the workbench probes the
  // currently focused editor and a custom/webview editor does not implement
  // that method. showTextDocument skips that probe.
  let doc: vscode.TextDocument | undefined;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    // Fall through to vscode.open for binary/custom-editor resources.
  }
  if (doc) {
    try {
      await vscode.window.showTextDocument(doc, options);
      return;
    } catch (error) {
      if (isInternalEditorControlError(error) && (await didOpenTextDocument(uri))) return;
      throw error;
    }
  }
  if (options) {
    await vscode.commands.executeCommand('vscode.open', uri, options);
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri);
}

async function retryTransientOpenFailure(open: () => Thenable<unknown>): Promise<void> {
  try {
    await open();
  } catch (error) {
    if (!isTransientOpenFailure(error)) throw error;
    await delay(RETRY_DELAY_MS);
    await open();
  }
}

function isTransientOpenFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(OPEN_EDITOR_ERROR) || isInternalEditorControlError(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInternalEditorControlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return INTERNAL_EDITOR_CONTROL_ERRORS.some((fragment) => message.includes(fragment));
}

async function didOpenTextDocument(uri: vscode.Uri): Promise<boolean> {
  await delay(RETRY_DELAY_MS);
  const key = uri.toString();
  return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === key);
}
