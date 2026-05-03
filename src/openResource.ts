import * as vscode from 'vscode';

const OPEN_EDITOR_ERROR = 'Could NOT open editor for';
const RETRY_DELAY_MS = 75;

export async function openResource(
  uri: vscode.Uri,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
  await retryTransientOpenFailure(() => executeOpen(uri, options));
}

export function formatOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(OPEN_EDITOR_ERROR)) {
    return 'VS Code could not create an editor for this resource.';
  }
  return message.replace(/^Error:\s*/, '') || 'Unknown error';
}

async function executeOpen(
  uri: vscode.Uri,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
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
  return message.includes(OPEN_EDITOR_ERROR);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
