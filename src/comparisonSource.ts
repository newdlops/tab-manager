import * as vscode from 'vscode';
import * as path from 'path';

export type ComparisonStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';

export interface ComparisonFileEntry {
  readonly uri: vscode.Uri;
  readonly status: ComparisonStatus;
  readonly command?: vscode.Command;
}

interface PublicComparisonChange {
  readonly status: ComparisonStatus;
  readonly path: string;
}

interface PublicComparisonSnapshot {
  readonly version: 1;
  readonly repoRoot: string;
  readonly changes: readonly PublicComparisonChange[];
}

interface GitSimpleCompareApi {
  readonly version: 1;
  readonly onDidChangeComparison: vscode.Event<void>;
  getComparison(): PublicComparisonSnapshot | undefined;
}

const EXTENSION_ID = 'newdlops.git-simple-compare';

/**
 * Git Simple Compare의 선택적 공개 API를 구독하고 현재 비교 파일을 캐시한다.
 * 확장이 설치되지 않았거나 API 활성화가 실패해도 빈 비교로 동작한다.
 */
export class ComparisonSource implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [this._onDidChange];
  private apiSubscription: vscode.Disposable | undefined;
  private entries: readonly ComparisonFileEntry[] = [];
  private api: GitSimpleCompareApi | undefined;

  constructor() {
    void this.bootstrap();
  }

  /** 현재 활성 비교의 파일 URI와 git 상태를 반환한다. */
  getEntries(): readonly ComparisonFileEntry[] {
    return this.entries;
  }

  /** 공개 API의 최신 스냅샷을 다시 읽고 소비자에게 변경을 알린다. */
  refresh(): void {
    const snapshot = this.readSnapshot();
    this.entries = comparisonEntriesFromSnapshot(snapshot);
    this._onDidChange.fire();
  }

  /** 선택적 확장을 안전하게 활성화하고 비교 변경 이벤트를 연결한다. */
  private async bootstrap(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitSimpleCompareApi>(EXTENSION_ID);
    if (!extension) return;

    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (!isGitSimpleCompareApi(exports)) return;
      this.api = exports;
      this.apiSubscription = exports.onDidChangeComparison(() => this.refresh());
      this.refresh();
    } catch {
      this.api = undefined;
      this.entries = [];
    }
  }

  /** API 오류가 Tab Manager 활성화까지 전파되지 않도록 현재 스냅샷을 보호해서 읽는다. */
  private readSnapshot(): PublicComparisonSnapshot | undefined {
    try {
      return this.api?.getComparison();
    } catch {
      return undefined;
    }
  }

  /** 이벤트와 API 리소스를 해제한다. */
  dispose(): void {
    this.apiSubscription?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** 공개 스냅샷의 저장소 상대 경로를 VS Code 파일 URI로 정규화한다. */
export function comparisonEntriesFromSnapshot(snapshot: unknown): ComparisonFileEntry[] {
  if (!isPublicComparisonSnapshot(snapshot) || !path.isAbsolute(snapshot.repoRoot)) return [];
  const root = vscode.Uri.file(snapshot.repoRoot);
  const entries: ComparisonFileEntry[] = [];
  const seen = new Set<string>();

  for (const change of snapshot.changes) {
    if (!isPublicComparisonChange(change)) continue;
    const segments = safeGitPathSegments(change.path);
    if (!segments || !isComparisonStatus(change.status)) continue;
    const uri = vscode.Uri.joinPath(root, ...segments);
    const key = uri.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      uri,
      status: change.status,
      ...(change.status === 'D'
        ? {
            command: {
              command: 'gitSimpleCompare.openComparisonFile',
              title: 'Open Deleted File with Red Line Markers',
              arguments: [{ repoRoot: snapshot.repoRoot, path: change.path }],
            },
          }
        : {}),
    });
  }
  return entries;
}

/** 외부 스냅샷의 필수 필드가 공개 계약에 맞는지 확인한다. */
function isPublicComparisonSnapshot(value: unknown): value is PublicComparisonSnapshot {
  return !!value && typeof value === 'object' &&
    (value as Partial<PublicComparisonSnapshot>).version === 1 &&
    typeof (value as Partial<PublicComparisonSnapshot>).repoRoot === 'string' &&
    Array.isArray((value as Partial<PublicComparisonSnapshot>).changes);
}

/** 개별 변경 항목이 경로와 상태 문자열을 제공하는지 확인한다. */
function isPublicComparisonChange(value: unknown): value is PublicComparisonChange {
  return !!value && typeof value === 'object' &&
    typeof (value as Partial<PublicComparisonChange>).path === 'string' &&
    typeof (value as Partial<PublicComparisonChange>).status === 'string';
}

/** 절대 경로와 상위 디렉터리 이동을 거부해 repoRoot 밖 URI 생성을 차단한다. */
function safeGitPathSegments(gitPath: string): string[] | undefined {
  if (!gitPath || gitPath.startsWith('/') || gitPath.includes('\\') || gitPath.includes('\0')) {
    return undefined;
  }
  const segments = gitPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
  return segments;
}

/** 런타임 export가 지원하는 Git Simple Compare API인지 판별한다. */
function isGitSimpleCompareApi(value: unknown): value is GitSimpleCompareApi {
  return !!value && typeof value === 'object' &&
    (value as Partial<GitSimpleCompareApi>).version === 1 &&
    typeof (value as Partial<GitSimpleCompareApi>).getComparison === 'function' &&
    typeof (value as Partial<GitSimpleCompareApi>).onDidChangeComparison === 'function';
}

/** 외부 API에서 받은 상태 문자열을 공개 계약의 상태 집합으로 제한한다. */
function isComparisonStatus(value: unknown): value is ComparisonStatus {
  return value === 'A' || value === 'M' || value === 'D' || value === 'R' ||
    value === 'C' || value === 'T' || value === 'U' || value === 'X' || value === 'B';
}
