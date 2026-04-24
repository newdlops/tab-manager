import * as vscode from 'vscode';
import type { SortState } from './groupStore';

export type TabTypeCategory =
  | 'text'
  | 'notebook'
  | 'diff'
  | 'custom'
  | 'webview'
  | 'terminal'
  | 'other';

const URI_NONE: vscode.Uri = vscode.Uri.parse('tab-manager:none');
const resourceUriCache = new WeakMap<vscode.Tab, vscode.Uri>();
const tabKeyCache = new WeakMap<vscode.Tab, string>();
const tabTypeCategoryCache = new WeakMap<vscode.Tab, TabTypeCategory>();
const tabTypeKeyCache = new WeakMap<vscode.Tab, string>();

export function resourceUriFor(tab: vscode.Tab): vscode.Uri | undefined {
  const cached = resourceUriCache.get(tab);
  if (cached) return cached === URI_NONE ? undefined : cached;
  const computed = computeResourceUri(tab);
  resourceUriCache.set(tab, computed ?? URI_NONE);
  return computed;
}

function computeResourceUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  if (input instanceof vscode.TabInputNotebookDiff) return input.modified;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

export function tabKey(tab: vscode.Tab): string {
  const cached = tabKeyCache.get(tab);
  if (cached !== undefined) return cached;
  const computed = computeTabKey(tab);
  tabKeyCache.set(tab, computed);
  return computed;
}

function computeTabKey(tab: vscode.Tab): string {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return `text::${input.uri.toString()}`;
  if (input instanceof vscode.TabInputTextDiff)
    return `diff::${input.original.toString()}::${input.modified.toString()}`;
  if (input instanceof vscode.TabInputNotebook)
    return `notebook::${input.notebookType}::${input.uri.toString()}`;
  if (input instanceof vscode.TabInputNotebookDiff)
    return `notebookDiff::${input.original.toString()}::${input.modified.toString()}`;
  if (input instanceof vscode.TabInputCustom)
    return `custom::${input.viewType}::${input.uri.toString()}`;
  if (input instanceof vscode.TabInputWebview) return `webview::${input.viewType}::${tab.label}`;
  if (input instanceof vscode.TabInputTerminal) return `terminal::${tab.label}`;
  return `unknown::${tab.label}`;
}

export function tabTypeCategory(tab: vscode.Tab): TabTypeCategory {
  const cached = tabTypeCategoryCache.get(tab);
  if (cached !== undefined) return cached;
  const computed = computeTabTypeCategory(tab);
  tabTypeCategoryCache.set(tab, computed);
  return computed;
}

function computeTabTypeCategory(tab: vscode.Tab): TabTypeCategory {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return 'text';
  if (input instanceof vscode.TabInputTextDiff) return 'diff';
  if (input instanceof vscode.TabInputNotebookDiff) return 'diff';
  if (input instanceof vscode.TabInputNotebook) return 'notebook';
  if (input instanceof vscode.TabInputCustom) return 'custom';
  if (input instanceof vscode.TabInputWebview) return 'webview';
  if (input instanceof vscode.TabInputTerminal) return 'terminal';
  return 'other';
}

export function tabTypeKey(tab: vscode.Tab): string {
  const cached = tabTypeKeyCache.get(tab);
  if (cached !== undefined) return cached;
  const computed = computeTabTypeKey(tab);
  tabTypeKeyCache.set(tab, computed);
  return computed;
}

function computeTabTypeKey(tab: vscode.Tab): string {
  const uri = resourceUriFor(tab);
  if (uri) {
    const p = uri.path;
    const slash = p.lastIndexOf('/');
    const dot = p.lastIndexOf('.');
    if (dot > slash) return p.slice(dot + 1).toLowerCase();
    return '';
  }
  const input = tab.input;
  if (input instanceof vscode.TabInputTerminal) return 'terminal';
  if (input instanceof vscode.TabInputWebview) return 'webview';
  return 'other';
}

export function sortTabs(tabs: vscode.Tab[], state: SortState): vscode.Tab[] {
  if (state.name === 'none' && !state.type) return tabs;

  const useType = state.type;
  const nameOrder: 0 | 1 | -1 = state.name === 'asc' ? 1 : state.name === 'desc' ? -1 : 0;

  const decorated = tabs.map((tab) => ({
    tab,
    typeKey: useType ? tabTypeKey(tab) : '',
    label: tab.label,
  }));

  decorated.sort((a, b) => {
    if (useType) {
      if (a.typeKey < b.typeKey) return -1;
      if (a.typeKey > b.typeKey) return 1;
    }
    if (nameOrder !== 0) {
      if (a.label < b.label) return -nameOrder;
      if (a.label > b.label) return nameOrder;
    }
    return 0;
  });

  const out = new Array<vscode.Tab>(decorated.length);
  for (let i = 0; i < decorated.length; i++) out[i] = decorated[i].tab;
  return out;
}

export async function openTab(tab: vscode.Tab): Promise<void> {
  const input = tab.input;
  const viewColumn = tab.group.viewColumn;
  const preview = tab.isPreview;

  if (input instanceof vscode.TabInputText) {
    await vscode.window.showTextDocument(input.uri, {
      viewColumn,
      preserveFocus: false,
      preview,
    });
    return;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, {
      viewColumn,
      preview,
    });
    return;
  }
  if (input instanceof vscode.TabInputNotebook) {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      input.uri,
      input.notebookType,
      viewColumn,
    );
    return;
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    await vscode.commands.executeCommand(
      'vscode.diff',
      input.original,
      input.modified,
      tab.label,
      { viewColumn, preview },
    );
    return;
  }
  if (input instanceof vscode.TabInputCustom) {
    await vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, viewColumn);
    return;
  }
  if (input instanceof vscode.TabInputTerminal) {
    const terminal = vscode.window.terminals.find((t) => t.name === tab.label);
    if (terminal) {
      terminal.show(false);
    } else {
      vscode.window.showInformationMessage(`Terminal "${tab.label}" could not be focused.`);
    }
    return;
  }
  vscode.window.showInformationMessage(`Cannot reopen tab type for "${tab.label}".`);
}
