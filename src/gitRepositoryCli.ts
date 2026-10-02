// 조회 전용 Git CLI 저장소 상태. 기본 Git을 꺼도 branch·remote·작업파일 정보를 제공한다.
import { execFile, type ExecFileException } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRepository, RepositoryBranch, RepositoryChange, RepositoryRemote } from './gitRepositoryTypes';

/**
 * GSC 실행 경로, 기본 Git 경로, PATH 순서로 조회용 실행 파일을 고른다.
 * @param cwd 설정의 워크스페이스·폴더 범위를 결정할 디렉터리
 * @returns 셸 인자를 포함하지 않는 실행 파일 경로
 */
function gitExecutable(cwd: string): string {
  const uri = vscode.Uri.file(cwd);
  const configured = vscode.workspace.getConfiguration('gitSimpleCompare', uri).get<unknown>('gitPath');
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const builtin = vscode.workspace.getConfiguration('git', uri).get<unknown>('path');
  if (typeof builtin === 'string' && builtin.trim()) return builtin.trim();
  if (Array.isArray(builtin)) {
    const first = builtin.find(value => typeof value === 'string' && value.trim());
    if (typeof first === 'string') return first.trim();
  }
  return 'git';
}

/**
 * 저장소·index를 변경하지 않는 조회를 셸 없이 실행하고 취소·제한 시간을 적용한다.
 * @param args 조회 전용 Git 인자
 * @param cwd 작업 디렉터리
 * @param signal 소스 해제 때 진행 중인 조회를 종료할 신호
 * @returns UTF-8 출력. 실행 오류에는 원래 Git 종료 코드를 보존한다.
 */
export function readGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitExecutable(cwd), args, {
      cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/**
 * 워크스페이스 폴더 안의 저장소와 linked worktree의 metadata 위치를 한 번에 찾는다.
 * @param cwd 존재하는 워크스페이스 폴더 경로
 * @returns 저장소가 맞으면 초기 상태를 읽은 CLI 저장소, 아니면 undefined
 */
export async function discoverCliRepository(cwd: string): Promise<CliRepository | undefined> {
  try {
    const lines = (await readGit(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], cwd)).trim().split(/\r?\n/);
    if (lines.length !== 3) return undefined;
    const repository = new CliRepository(lines[0], lines[1], path.resolve(cwd, lines[2]));
    try { await repository.status(); return repository; }
    catch (error) { repository.dispose(); throw error; }
  } catch (error) {
    // 비 Git 폴더만 조용히 제외하고 실제 실행 실패는 공급자 OUTPUT에 전달한다.
    if ((error as ExecFileException).code === 128 && /not a git repository/i.test(String(error))) return undefined;
    throw error;
  }
}

/** 중복 조회를 합치고 변경된 상태만 소비자에게 알리는 독립 CLI 저장소다. */
export class CliRepository implements GitRepository, vscode.Disposable {
  readonly rootUri: vscode.Uri;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly state = {
    HEAD: undefined as RepositoryBranch | undefined,
    remotes: [] as RepositoryRemote[],
    workingTreeChanges: [] as RepositoryChange[],
    onDidChange: this.changed.event,
  };
  private readonly cancellation = new AbortController();
  private flight?: Promise<void>;
  private pending = false;
  private remotesDirty = true;
  private disposed = false;
  private signature = '';

  /** @param root 저장소 루트 @param gitDir worktree metadata @param commonDir 공유 ref·config 디렉터리 */
  constructor(root: string, readonly gitDir: string, readonly commonDir: string) {
    this.rootUri = vscode.Uri.file(root);
  }

  /** 원격 설정 변경 뒤 다음 status가 URL 목록을 다시 읽게 한다. */
  invalidateRemotes(): void { this.remotesDirty = true; }

  /** 동시 요청을 합치되 조회 중 도착한 변경을 마지막 추가 pass에서 반영한다. */
  status(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending = true;
    if (this.flight) return this.flight;
    this.flight = this.refresh().finally(() => { this.flight = undefined; });
    return this.flight;
  }

  /** 변경·원격 상태를 한 세대씩 적용해 PR과 필터가 같은 snapshot을 읽게 한다. */
  private async refresh(): Promise<void> {
    while (this.pending && !this.disposed) {
      this.pending = false;
      if (this.remotesDirty) {
        this.remotesDirty = false;
        try { this.state.remotes = await this.readRemotes(); }
        catch (error) { this.remotesDirty = true; throw error; }
      }
      const output = await readGit(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], this.rootUri.fsPath, this.cancellation.signal);
      if (this.disposed) return;
      const parsed = parsePorcelainStatus(output, this.state.remotes);
      const changes = parsed.changes.map(change => ({ uri: vscode.Uri.file(path.join(this.rootUri.fsPath, change.path)), status: change.status }));
      const signature = JSON.stringify([parsed.branch, this.state.remotes, parsed.changes]);
      this.state.HEAD = parsed.branch;
      this.state.workingTreeChanges = changes;
      if (signature !== this.signature) { this.signature = signature; this.changed.fire(); }
    }
  }

  /** Git remote URL을 NUL 구분 출력으로 읽어 공백·중복 remote 설정을 보존한다. */
  private async readRemotes(): Promise<RepositoryRemote[]> {
    let output: string;
    try { output = await readGit(['config', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], this.rootUri.fsPath, this.cancellation.signal); }
    catch (error) { if ((error as ExecFileException).code === 1) return []; throw error; }
    const remotes = new Map<string, { name: string; fetchUrl?: string; pushUrl?: string }>();
    for (const record of output.split('\0')) {
      const newline = record.indexOf('\n');
      const match = record.slice(0, newline).match(/^remote\.(.+)\.(url|pushurl)$/);
      if (newline < 0 || !match) continue;
      const remote = remotes.get(match[1]) ?? { name: match[1] };
      if (match[2] === 'url') remote.fetchUrl ??= record.slice(newline + 1);
      else remote.pushUrl ??= record.slice(newline + 1);
      remotes.set(remote.name, remote);
    }
    return [...remotes.values()];
  }

  /** 진행 중인 읽기를 취소하고 repository 이벤트를 해제한다. */
  dispose(): void { this.disposed = true; this.cancellation.abort(); this.changed.dispose(); }
}

/**
 * NUL 상태 출력을 파싱해 줄바꿈 파일명과 staged rename의 원본 경로를 정확히 처리한다.
 * @param output git status --porcelain=v1 -z --branch 출력
 * @param remotes upstream 이름을 remote와 branch로 분리할 현재 원격 목록
 * @returns 현재 branch와 미스테이징 변경의 Git API 상태 코드
 */
export function parsePorcelainStatus(output: string, remotes: readonly RepositoryRemote[]): {
  branch?: RepositoryBranch; changes: Array<{ path: string; status: number }>;
} {
  const records = output.split('\0');
  const result: { branch?: RepositoryBranch; changes: Array<{ path: string; status: number }> } = { changes: [] };
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('## ')) { result.branch = parseBranch(record.slice(3), remotes); continue; }
    if (record.length < 4) continue;
    const x = record[0], y = record[1];
    const status = x === '?' && y === '?' ? 7 : y === 'M' ? 5 : y === 'D' ? 6 : y === 'T' ? 10 : y === 'A' ? 9 : undefined;
    if (status !== undefined) result.changes.push({ path: record.slice(3), status });
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index++;
  }
  return result;
}

/** status header에서 detached·unborn 상태와 upstream remote 이름을 분리한다. */
function parseBranch(header: string, remotes: readonly RepositoryRemote[]): RepositoryBranch | undefined {
  if (header.startsWith('HEAD (')) return undefined;
  const clean = header.replace(/^(No commits yet on |Initial commit on )/, '').replace(/ \[.*\]$/, '');
  const [name, upstream] = clean.split('...');
  if (!name || name === 'HEAD') return undefined;
  const remote = [...remotes].sort((a, b) => b.name.length - a.name.length).find(candidate => upstream?.startsWith(candidate.name + '/'));
  return { name, ...(remote && upstream ? { upstream: { remote: remote.name, name: upstream } } : {}) };
}
