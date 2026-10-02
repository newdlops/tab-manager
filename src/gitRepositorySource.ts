// PR·Git 파일 필터가 공유하는 저장소 정보 공급자.
// - 기본 Git이 동작하면 기존 API를 재사용하고 중단·초기화 실패 때만 조회 전용 CLI로 전환한다.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CliRepository, discoverCliRepository } from './gitRepositoryCli';
import type { GitRepository, RepositoryAPI } from './gitRepositoryTypes';

interface BuiltinGitExtension {
  readonly enabled?: boolean;
  readonly onDidChangeEnablement?: vscode.Event<boolean>;
  getAPI(version: 1): RepositoryAPI;
}

let shared: GitRepositorySource | undefined;
let ready: Promise<GitRepositorySource> | undefined;

/** 두 소비자의 동시 초기화를 합쳐 하나의 저장소 탐색·상태 캐시를 공유한다. */
export function getRepositorySource(): Promise<GitRepositorySource> {
  if (!ready) {
    const source = shared = new GitRepositorySource();
    ready = source.refreshSource().then(() => source);
  }
  return ready;
}

/** Explorer의 기존 파일 watcher 이벤트를 CLI 소스에 전달해 별도 전역 watcher·polling을 피한다. */
export function scheduleRepositoryFileRefresh(uri: vscode.Uri): void { shared?.scheduleFileRefresh(uri); }

/** 확장 컨텍스트 종료 시 공유 이벤트·프로세스·metadata watcher를 한 번만 해제한다. */
export function disposeRepositorySource(): void { shared?.dispose(); shared = undefined; ready = undefined; }

/** 소스 전환을 repository open/close 이벤트로 투영하는 공통 Git API 어댑터다. */
export class GitRepositorySource implements RepositoryAPI, vscode.Disposable {
  private readonly opened = new vscode.EventEmitter<GitRepository>();
  private readonly closed = new vscode.EventEmitter<GitRepository>();
  readonly onDidOpenRepository = this.opened.event;
  readonly onDidCloseRepository = this.closed.event;
  private current: readonly GitRepository[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private sourceSubscriptions: vscode.Disposable[] = [];
  private cliRepositories: CliRepository[] = [];
  private nativeGit?: BuiltinGitExtension;
  private flight?: Promise<void>;
  private pending = false;
  private disposed = false;
  private usingCli = false;
  private fileTimer?: ReturnType<typeof setTimeout>;
  private sourceTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingFiles = new Set<CliRepository>();
  private readonly output = vscode.window.createOutputChannel('Tab Manager');

  /** Git 설정·워크스페이스 변경만 소스 재탐색을 요청하고 idle 중 polling은 만들지 않는다. */
  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (['git.enabled', 'git.path', 'gitSimpleCompare.gitPath'].some(key => event.affectsConfiguration(key))) {
          this.scheduleSourceRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleSourceRefresh()),
      vscode.workspace.onDidSaveTextDocument(document => this.scheduleFileRefresh(document.uri)),
    );
  }

  /** 현재 소스의 repository snapshot을 동기 조회하는 공통 API다. */
  get repositories(): readonly GitRepository[] { return this.current; }

  /** 가장 구체적인 저장소 루트를 선택해 multi-root·중첩 native repository를 처리한다. */
  getRepository(uri: vscode.Uri): GitRepository | null {
    return [...this.current].sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)
      .find(repository => isInside(uri, repository.rootUri)) ?? null;
  }

  /** 설정 전환 중 겹친 초기화를 합치고 마지막 설정까지 순차 적용한다. */
  refreshSource(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending = true;
    if (this.flight) return this.flight;
    this.flight = this.refreshLoop().finally(() => { this.flight = undefined; });
    return this.flight;
  }

  /** 다음 소스를 준비하고 이전 상태 이벤트·metadata watcher를 함께 교체한다. */
  private async refreshLoop(): Promise<void> {
    while (this.pending && !this.disposed) {
      this.pending = false;
      for (const subscription of this.sourceSubscriptions.splice(0)) subscription.dispose();
      const native = await this.tryBuiltinGit();
      if (this.disposed) return;
      this.replaceRepositories(native?.repositories ?? []);
      for (const repository of this.cliRepositories.splice(0)) repository.dispose();
      if (native) {
        this.sourceSubscriptions.push(
          native.onDidOpenRepository(() => this.mergeNativeRepositories(native)),
          native.onDidCloseRepository(() => this.mergeNativeRepositories(native)),
        );
      }
      const seen = new Set(this.current.map(repository => repository.rootUri.toString()));
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') continue;
        if (native && vscode.workspace.getConfiguration('git', folder.uri).get<boolean>('enabled', true)) continue;
        try {
          const repository = await discoverCliRepository(folder.uri.fsPath);
          if (!repository) continue;
          if (seen.has(repository.rootUri.toString())) { repository.dispose(); continue; }
          seen.add(repository.rootUri.toString());
          this.cliRepositories.push(repository);
        } catch (error) { this.log('git repository discovery failed', { folder: folder.name, error: String(error) }); }
      }
      if (this.disposed) { for (const repository of this.cliRepositories.splice(0)) repository.dispose(); return; }
      this.usingCli = this.cliRepositories.length > 0 || !native;
      if (native) this.mergeNativeRepositories(native);
      else this.replaceRepositories(this.cliRepositories);
      this.watchGitMetadata();
      this.log('git source ready', { source: native ? this.usingCli ? 'mixed' : 'vscode.git' : 'cli', repositories: this.current.length });
    }
  }

  /** 중단된 Git model을 강제 사용하지 않고 API 조회 예외도 CLI fallback으로 전환한다. */
  private async tryBuiltinGit(): Promise<RepositoryAPI | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    const enabled = folders?.length
      ? folders.some(folder => vscode.workspace.getConfiguration('git', folder.uri).get<boolean>('enabled', true))
      : vscode.workspace.getConfiguration('git').get<boolean>('enabled', true);
    if (!enabled) return undefined;
    const extension = vscode.extensions.getExtension<BuiltinGitExtension>('vscode.git');
    if (!extension) return undefined;
    try {
      const git = extension.isActive ? extension.exports : await extension.activate();
      if (git !== this.nativeGit) {
        this.nativeGit = git;
        if (git.onDidChangeEnablement) this.subscriptions.push(git.onDidChangeEnablement(() => this.scheduleSourceRefresh()));
      }
      return git.enabled === false ? undefined : git.getAPI(1);
    } catch (error) { this.log('built-in git unavailable; using cli', { error: String(error) }); return undefined; }
  }

  /** 저장소 객체 교체를 open/close로 알려 소비자가 상태 구독을 함께 교체하게 한다. */
  private replaceRepositories(next: readonly GitRepository[]): void {
    const previous = this.current;
    this.current = [...next];
    for (const repository of previous) if (!next.includes(repository)) this.closed.fire(repository);
    for (const repository of next) if (!previous.includes(repository)) this.opened.fire(repository);
  }

  /** 기본 Git이 켜진 폴더와 CLI가 담당하는 폴더를 중복 없이 한 목록으로 합친다. */
  private mergeNativeRepositories(native: RepositoryAPI): void {
    const repositories = native.repositories.filter(repository =>
      vscode.workspace.getConfiguration('git', repository.rootUri).get<boolean>('enabled', true));
    const roots = new Set(repositories.map(repository => repository.rootUri.toString()));
    this.replaceRepositories([...repositories, ...this.cliRepositories.filter(repository => !roots.has(repository.rootUri.toString()))]);
  }

  /** 설정·enablement 이벤트를 합쳐 같은 전환으로 CLI 탐색을 반복하지 않는다. */
  private scheduleSourceRefresh(): void {
    clearTimeout(this.sourceTimer);
    this.sourceTimer = setTimeout(() => { void this.refreshSource().catch(error => {
      if (!this.disposed) this.log('git source refresh failed', { error: String(error) });
    }); }, 100);
  }

  /** HEAD·index·refs·config만 감시하고 objects·fsmonitor cookie 이벤트는 제외한다. */
  private watchGitMetadata(): void {
    const directories = new Set(this.cliRepositories.flatMap(repository => [repository.gitDir, repository.commonDir]));
    for (const directory of directories) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '{HEAD,index,config,packed-refs,refs/**}'));
      const changed = (uri: vscode.Uri): void => {
        for (const repository of this.cliRepositories) {
          if (![repository.gitDir, repository.commonDir].some(base => isInside(uri, vscode.Uri.file(base)))) continue;
          if (path.basename(uri.fsPath) === 'config') repository.invalidateRemotes();
          this.pendingFiles.add(repository);
        }
        this.schedulePendingFiles();
      };
      this.sourceSubscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    }
  }

  /** 기존 Explorer의 파일 변경을 해당 CLI 저장소의 상태 갱신으로 좁힌다. */
  scheduleFileRefresh(uri: vscode.Uri): void {
    if (!this.usingCli || this.disposed) return;
    const repository = this.getRepository(uri);
    if (repository instanceof CliRepository) { this.pendingFiles.add(repository); this.schedulePendingFiles(); }
  }

  /** 짧은 이벤트를 한 번의 status로 합치고 실패는 다음 변경·수동 갱신에서 재시도한다. */
  private schedulePendingFiles(): void {
    clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => {
      const repositories = [...this.pendingFiles];
      this.pendingFiles.clear();
      if (!this.usingCli || this.disposed) return;
      for (const repository of repositories) void repository.status().catch(error => {
        if (!this.disposed) this.log('git status refresh failed', { root: repository.rootUri.fsPath, error: String(error) });
      });
    }, 500);
  }

  /** 소스 변경·오류를 OUTPUT에 남기되 원격 URL·인증 정보는 기록하지 않는다. */
  private log(message: string, details: Record<string, unknown>): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message} ${JSON.stringify(details)}`);
  }

  /** 공유 소스를 종료하고 진행 중인 CLI 읽기·이벤트·지연 timer를 모두 해제한다. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.fileTimer);
    clearTimeout(this.sourceTimer);
    for (const disposable of [...this.subscriptions, ...this.sourceSubscriptions, ...this.cliRepositories]) disposable.dispose();
    this.opened.dispose(); this.closed.dispose(); this.output.dispose();
  }
}

/** URI가 저장소 루트 또는 하위 파일인지 경로 경계를 포함해 판단한다. */
function isInside(uri: vscode.Uri, root: vscode.Uri): boolean {
  if (uri.scheme !== root.scheme || uri.authority !== root.authority) return false;
  const relative = path.relative(root.fsPath, uri.fsPath);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
