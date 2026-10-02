// 기본 Git API와 CLI fallback이 공유하는 최소 저장소 상태 계약.
import type * as vscode from 'vscode';

export interface RepositoryBranch {
  readonly name?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
}

export interface RepositoryRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

export interface RepositoryChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}

export interface RepositoryState {
  readonly HEAD?: RepositoryBranch;
  readonly remotes: readonly RepositoryRemote[];
  readonly workingTreeChanges: readonly RepositoryChange[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
  status(): Promise<void>;
}

export interface RepositoryAPI {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}
