import * as vscode from 'vscode';
import type { FilterSource } from './filterSource';

export class UnsavedDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly disposable: vscode.Disposable;

  constructor(private readonly filter: FilterSource) {
    this.disposable = filter.onDidChange(() => this._onDidChange.fire(undefined));
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
