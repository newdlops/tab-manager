import * as vscode from 'vscode';
import type { SortState } from './groupStore';
import { formatOpenError, openResource } from './openResource';

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
const FOCUS_EDITOR_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

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
  const input = tab.input;
  if (input instanceof vscode.TabInputTextDiff) {
    const ext = fileExt(input.modified) || fileExt(input.original);
    if (isGitWorkingTreeDiff(input.original, input.modified)) {
      return `git-working-tree:${ext}`;
    }
    return `diff:${ext}`;
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    const ext = fileExt(input.modified) || fileExt(input.original);
    return `notebook-diff:${ext}`;
  }

  const uri = resourceUriFor(tab);
  if (uri) {
    const ext = fileExt(uri);
    if (uri.scheme === 'git') return `git:${ext}`;
    return ext;
  }
  if (input instanceof vscode.TabInputTerminal) return 'terminal';
  if (input instanceof vscode.TabInputWebview) return 'webview';
  return 'other';
}

export function tabColumnKey(tab: vscode.Tab): string {
  return String(tab.group.viewColumn);
}

export function tabColumnLabel(tab: vscode.Tab): string {
  return columnLabel(tab.group.viewColumn);
}

export function columnLabel(viewColumn: vscode.ViewColumn): string {
  return viewColumn > 0 ? `Column ${viewColumn}` : 'Column';
}

function fileExt(uri: vscode.Uri): string {
  const p = uri.path;
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  return dot > slash ? p.slice(dot + 1).toLowerCase() : '';
}

function isGitWorkingTreeDiff(original: vscode.Uri, modified: vscode.Uri): boolean {
  return original.scheme === 'git' || modified.scheme === 'git';
}

export function sortTabs(
  tabs: vscode.Tab[],
  state: SortState,
  isReadOnly?: (tab: vscode.Tab) => boolean,
): vscode.Tab[] {
  const useReadOnly = state.readOnly && !!isReadOnly;
  if (state.name === 'none' && !state.type && !useReadOnly) return tabs;

  const useType = state.type;
  const nameOrder: 0 | 1 | -1 = state.name === 'asc' ? 1 : state.name === 'desc' ? -1 : 0;

  const decorated = tabs.map((tab) => ({
    tab,
    typeKey: useType ? tabTypeKey(tab) : '',
    readOnly: useReadOnly && isReadOnly!(tab) ? 0 : 1,
    label: tab.label,
  }));

  decorated.sort((a, b) => {
    if (useReadOnly && a.readOnly !== b.readOnly) return a.readOnly - b.readOnly;
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
  try {
    if (await focusExistingTab(tab)) return;
    if (canReopenTab(tab)) {
      await reopenTabResource(tab);
      return;
    }
    throw new Error('The tab is no longer available.');
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to open "${tab.label}": ${formatOpenError(error)}`);
  }
}

function canReopenTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  return (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputTextDiff ||
    input instanceof vscode.TabInputNotebook ||
    input instanceof vscode.TabInputNotebookDiff ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputTerminal
  );
}

async function focusExistingTab(tab: vscode.Tab): Promise<boolean> {
  const location = findLiveTabLocation(tab);
  if (!location) return false;

  await focusEditorGroup(location.groupIndex);
  await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', location.tabIndex);
  return true;
}

type TabLocation = { groupIndex: number; tabIndex: number };

function findLiveTabLocation(tab: vscode.Tab): TabLocation | undefined {
  const groups = vscode.window.tabGroups.all;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const tabIndex = groups[groupIndex].tabs.findIndex((t) => t === tab);
    if (tabIndex !== -1) return { groupIndex, tabIndex };
  }

  const key = tabKey(tab);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const tabIndex = groups[groupIndex].tabs.findIndex((t) => tabKey(t) === key);
    if (tabIndex !== -1) return { groupIndex, tabIndex };
  }
  return findUniqueNonResourceTabByLabel(tab, groups);
}

function findUniqueNonResourceTabByLabel(
  tab: vscode.Tab,
  groups: readonly vscode.TabGroup[],
): TabLocation | undefined {
  if (resourceUriFor(tab)) return undefined;

  let match: TabLocation | undefined;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const tabs = groups[groupIndex].tabs;
    for (let tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
      const candidate = tabs[tabIndex];
      if (candidate.label !== tab.label || resourceUriFor(candidate)) continue;
      if (match) return undefined;
      match = { groupIndex, tabIndex };
    }
  }
  return match;
}

async function focusEditorGroup(groupIndex: number): Promise<void> {
  const directCommand = FOCUS_EDITOR_GROUP_COMMANDS[groupIndex];
  if (directCommand) {
    await vscode.commands.executeCommand(directCommand);
    return;
  }

  await vscode.commands.executeCommand(FOCUS_EDITOR_GROUP_COMMANDS[0]);
  for (let i = 0; i < groupIndex; i++) {
    await vscode.commands.executeCommand('workbench.action.focusNextGroup');
  }
}

async function reopenTabResource(tab: vscode.Tab): Promise<void> {
  const input = tab.input;
  const viewColumn = tab.group.viewColumn;
  const preview = tab.isPreview;

  if (input instanceof vscode.TabInputText) {
    await openResource(input.uri, {
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
  throw new Error('The tab is no longer available.');
}
