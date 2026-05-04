import * as vscode from 'vscode';
import type { FilterSource } from './filterSource';

export class UnsavedDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly disposable: vscode.Disposable;
  private prevKeys: Set<string> = new Set();

  constructor(private readonly filter: FilterSource) {
    this.prevKeys = new Set(filter.getDirtyKeySet());
    this.disposable = filter.onDidChange(() => this.fireDelta());
  }

  private fireDelta(): void {
    const current = this.filter.getDirtyKeySet();
    const changed: vscode.Uri[] = [];
    for (const k of this.prevKeys) {
      if (!current.has(k)) changed.push(vscode.Uri.parse(k));
    }
    for (const k of current) {
      if (!this.prevKeys.has(k)) changed.push(vscode.Uri.parse(k));
    }
    this.prevKeys = new Set(current);
    if (changed.length === 0) return;
    this._onDidChange.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    if (!this.filter.isDirty(uri)) return undefined;
    return {
      badge: '●',
      tooltip: 'Unsaved changes',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      propagate: false,
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChange.dispose();
  }
}
