import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { debounce } from './util';

export interface PullRequestCommentRefreshOptions {
  createSession?: boolean;
  showStatus?: boolean;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
  getRepository?(uri: vscode.Uri): Repository | null;
}

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepoState;
}

interface RepoState {
  readonly HEAD?: Branch;
  readonly remotes: readonly Remote[];
  readonly onDidChange: vscode.Event<void>;
}

interface Branch {
  readonly name?: string;
  readonly upstream?: {
    readonly remote: string;
    readonly name: string;
  };
}

interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

interface GithubRemote {
  readonly remoteName: string;
  readonly owner: string;
  readonly repo: string;
}

interface PullRequestLookupContext {
  readonly repository: Repository;
  readonly branchName: string;
  readonly baseRemotes: readonly GithubRemote[];
  readonly headRemotes: readonly GithubRemote[];
}

interface PullRequestSummary {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

interface PullRequestCommentDecoration {
  readonly count: number;
  readonly pullRequestNumber: number;
}

interface GithubPullRequestItem {
  readonly number?: unknown;
}

interface GithubPullRequestComment {
  readonly path?: unknown;
}

class GithubHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubHttpError';
  }
}

export class PullRequestCommentDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly _onDidChangeCommentedFiles = new vscode.EventEmitter<void>();
  readonly onDidChangeCommentedFiles = this._onDidChangeCommentedFiles.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoDisposables = new Map<Repository, vscode.Disposable>();
  private readonly scheduleRefresh = debounce(() => {
    void this.refresh();
  }, 500);

  private git: GitAPI | undefined;
  private decorations = new Map<string, PullRequestCommentDecoration>();
  private refreshToken = 0;

  constructor() {
    this.disposables.push(
      this._onDidChange,
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id === 'github') this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
    );
    void this.bootstrapGit();
  }

  async refresh(options: PullRequestCommentRefreshOptions = {}): Promise<void> {
    const token = ++this.refreshToken;
    try {
      const context = this.resolvePullRequestContext();
      if (!context) {
        this.applyDecorations(new Map(), token);
        if (options.showStatus) {
          void vscode.window.showInformationMessage(
            'No GitHub pull request context found for the current branch.',
          );
        }
        return;
      }

      const accessToken = await getGithubAccessToken(!!options.createSession);
      if (token !== this.refreshToken) return;

      const pullRequest = await this.findCurrentPullRequest(context, accessToken);
      if (!pullRequest) {
        this.applyDecorations(new Map(), token);
        if (options.showStatus) {
          void vscode.window.showInformationMessage(
            'No open GitHub pull request found for the current branch.',
          );
        }
        return;
      }

      const comments = await readPullRequestComments(pullRequest, accessToken);
      if (token !== this.refreshToken) return;

      const next = new Map<string, PullRequestCommentDecoration>();
      for (const comment of comments) {
        if (typeof comment.path !== 'string' || comment.path.length === 0) continue;
        const uri = uriForRepoPath(context.repository.rootUri, comment.path);
        const key = uri.toString();
        const previous = next.get(key);
        next.set(key, {
          count: (previous?.count ?? 0) + 1,
          pullRequestNumber: pullRequest.number,
        });
      }

      this.applyDecorations(next, token);
      if (options.showStatus) {
        const count = comments.length;
        void vscode.window.showInformationMessage(
          `Loaded ${count} PR review comment${count === 1 ? '' : 's'} from #${pullRequest.number}.`,
        );
      }
    } catch (error) {
      if (options.showStatus) {
        void vscode.window.showErrorMessage(
          `Failed to refresh PR comments: ${formatError(error)}`,
        );
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const decoration = this.decorations.get(uri.toString());
    if (!decoration) return undefined;
    return {
      badge: commentBadge(decoration.count),
      tooltip: `${decoration.count} PR review comment${decoration.count === 1 ? '' : 's'} on #${decoration.pullRequestNumber}`,
      color: new vscode.ThemeColor('charts.yellow'),
      propagate: false,
    };
  }

  getCommentedUris(): vscode.Uri[] {
    return [...this.decorations.keys()].map((key) => vscode.Uri.parse(key));
  }

  dispose(): void {
    for (const disposable of this.repoDisposables.values()) disposable.dispose();
    this.repoDisposables.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this._onDidChangeCommentedFiles.dispose();
  }

  private async bootstrapGit(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return;
    if (!ext.isActive) {
      try {
        await ext.activate();
      } catch {
        return;
      }
    }
    this.git = ext.exports.getAPI(1);
    for (const repository of this.git.repositories) this.attachRepository(repository);
    this.disposables.push(
      this.git.onDidOpenRepository((repository) => {
        this.attachRepository(repository);
        this.scheduleRefresh();
      }),
      this.git.onDidCloseRepository((repository) => {
        this.repoDisposables.get(repository)?.dispose();
        this.repoDisposables.delete(repository);
        this.scheduleRefresh();
      }),
    );
    this.scheduleRefresh();
  }

  private attachRepository(repository: Repository): void {
    if (this.repoDisposables.has(repository)) return;
    this.repoDisposables.set(repository, repository.state.onDidChange(() => this.scheduleRefresh()));
  }

  private resolvePullRequestContext(): PullRequestLookupContext | undefined {
    const repository = this.currentRepository();
    if (!repository) return undefined;

    const branchName = branchNameFor(repository.state.HEAD);
    if (!branchName) return undefined;

    const remotes = githubRemotes(repository.state.remotes);
    if (remotes.length === 0) return undefined;

    const upstreamRemote = repository.state.HEAD?.upstream?.remote;
    const headRemotes = orderedRemotes(remotes, [upstreamRemote, 'origin']);
    const baseRemotes = orderedRemotes(remotes, ['upstream', 'origin', upstreamRemote]);
    return { repository, branchName, baseRemotes, headRemotes };
  }

  private currentRepository(): Repository | undefined {
    if (!this.git) return undefined;

    const activeUri = activeWorkspaceUri();
    if (activeUri && this.git.getRepository) {
      const repository = this.git.getRepository(activeUri);
      if (repository) return repository;
    }

    if (activeUri) {
      const repository = this.git.repositories.find((candidate) =>
        isSameOrInside(activeUri, candidate.rootUri),
      );
      if (repository) return repository;
    }

    return this.git.repositories[0];
  }

  private async findCurrentPullRequest(
    context: PullRequestLookupContext,
    accessToken: string | undefined,
  ): Promise<PullRequestSummary | undefined> {
    for (const base of context.baseRemotes) {
      for (const head of context.headRemotes) {
        try {
          const pullRequest = await readOpenPullRequest(
            base,
            head.owner,
            context.branchName,
            accessToken,
          );
          if (pullRequest) return pullRequest;
        } catch (error) {
          if (
            error instanceof GithubHttpError &&
            (error.statusCode === 404 || error.statusCode === 422)
          ) {
            continue;
          }
          throw error;
        }
      }
    }
    return undefined;
  }

  private applyDecorations(
    next: Map<string, PullRequestCommentDecoration>,
    token: number,
  ): void {
    if (token !== this.refreshToken) return;

    const changed: vscode.Uri[] = [];
    const keys = new Set([...this.decorations.keys(), ...next.keys()]);
    for (const key of keys) {
      const before = this.decorations.get(key);
      const after = next.get(key);
      if (
        before?.count !== after?.count ||
        before?.pullRequestNumber !== after?.pullRequestNumber
      ) {
        changed.push(vscode.Uri.parse(key));
      }
    }

    this.decorations = next;
    if (changed.length > 0) {
      this._onDidChange.fire(changed);
      this._onDidChangeCommentedFiles.fire();
    }
  }
}

async function getGithubAccessToken(createSession: boolean): Promise<string | undefined> {
  try {
    const session = createSession
      ? await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: {
            detail: 'Tab Manager reads pull request review comments to show file badges.',
          },
        })
      : await vscode.authentication.getSession('github', ['repo'], { silent: true });
    return session?.accessToken;
  } catch {
    return undefined;
  }
}

async function readOpenPullRequest(
  base: GithubRemote,
  headOwner: string,
  branchName: string,
  accessToken: string | undefined,
): Promise<PullRequestSummary | undefined> {
  const url = githubApiUrl(
    `/repos/${encodePathPart(base.owner)}/${encodePathPart(base.repo)}/pulls`,
    {
      state: 'open',
      head: `${headOwner}:${branchName}`,
      per_page: '1',
    },
  );
  const { value } = await githubJson<unknown[]>(url, accessToken);
  const item = value.find(isGithubPullRequestItem);
  if (!item || typeof item.number !== 'number') return undefined;
  return {
    owner: base.owner,
    repo: base.repo,
    number: item.number,
  };
}

async function readPullRequestComments(
  pullRequest: PullRequestSummary,
  accessToken: string | undefined,
): Promise<GithubPullRequestComment[]> {
  const comments: GithubPullRequestComment[] = [];
  let url: string | undefined = githubApiUrl(
    `/repos/${encodePathPart(pullRequest.owner)}/${encodePathPart(pullRequest.repo)}/pulls/${pullRequest.number}/comments`,
    { per_page: '100' },
  );

  while (url) {
    const { value, headers } = await githubJson<unknown[]>(url, accessToken);
    comments.push(...value.filter(isGithubPullRequestComment));
    url = nextPageUrl(headers);
  }

  return comments;
}

function githubJson<T>(
  url: string,
  accessToken: string | undefined,
): Promise<{ value: T; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'newdlops-tab-manager',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new GithubHttpError(statusCode, githubErrorMessage(statusCode, body)));
          return;
        }
        try {
          resolve({
            value: (body ? JSON.parse(body) : undefined) as T,
            headers: res.headers,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('GitHub request timed out.')));
    req.on('error', reject);
    req.end();
  });
}

function githubApiUrl(pathname: string, params: Record<string, string>): string {
  const url = new URL(`https://api.github.com${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function nextPageUrl(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.link;
  const link = Array.isArray(raw) ? raw.join(',') : raw;
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

function githubErrorMessage(statusCode: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return `GitHub API returned ${statusCode}: ${parsed.message}`;
    }
  } catch {
    /* ignore malformed error payload */
  }
  return `GitHub API returned ${statusCode}`;
}

function githubRemotes(remotes: readonly Remote[]): GithubRemote[] {
  const result: GithubRemote[] = [];
  const seen = new Set<string>();
  for (const remote of remotes) {
    const parsed = parseGithubRemote(remote.fetchUrl) ?? parseGithubRemote(remote.pushUrl);
    if (!parsed) continue;
    const key = `${remote.name}:${parsed.owner}/${parsed.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ remoteName: remote.name, ...parsed });
  }
  return result;
}

function orderedRemotes(
  remotes: readonly GithubRemote[],
  preferredNames: readonly (string | undefined)[],
): GithubRemote[] {
  const result: GithubRemote[] = [];
  const seen = new Set<string>();
  const add = (remote: GithubRemote | undefined) => {
    if (!remote) return;
    const key = `${remote.owner}/${remote.repo}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(remote);
  };

  for (const name of preferredNames) {
    if (!name) continue;
    add(remotes.find((remote) => remote.remoteName === name));
  }
  for (const remote of remotes) add(remote);
  return result;
}

function parseGithubRemote(raw: string | undefined): { owner: string; repo: string } | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1], repo: stripGitSuffix(sshMatch[2]) };

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const [owner, repo] = url.pathname.replace(/^\/+/, '').split('/');
    if (!owner || !repo) return undefined;
    return { owner, repo: stripGitSuffix(repo) };
  } catch {
    return undefined;
  }
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

function branchNameFor(head: Branch | undefined): string | undefined {
  return (
    normalizeBranchName(head?.upstream?.name, head?.upstream?.remote) ??
    normalizeBranchName(head?.name)
  );
}

function normalizeBranchName(name: string | undefined, remoteName?: string): string | undefined {
  if (!name) return undefined;
  let branch = name.trim();
  if (!branch || branch === 'HEAD') return undefined;
  branch = branch.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  if (remoteName && branch.startsWith(`${remoteName}/`)) {
    branch = branch.slice(remoteName.length + 1);
  }
  return branch || undefined;
}

function uriForRepoPath(rootUri: vscode.Uri, repoPath: string): vscode.Uri {
  return vscode.Uri.joinPath(rootUri, ...repoPath.split('/').filter(Boolean));
}

function activeWorkspaceUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') return active;
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function isSameOrInside(uri: vscode.Uri, root: vscode.Uri): boolean {
  if (uri.scheme === 'file' && root.scheme === 'file') {
    const relative = path.relative(root.fsPath, uri.fsPath);
    return (
      relative === '' ||
      (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }
  const rootString = root.toString();
  const uriString = uri.toString();
  return uriString === rootString || uriString.startsWith(`${rootString}/`);
}

function isGithubPullRequestItem(value: unknown): value is GithubPullRequestItem {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as GithubPullRequestItem).number === 'number'
  );
}

function isGithubPullRequestComment(value: unknown): value is GithubPullRequestComment {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as GithubPullRequestComment).path === 'string'
  );
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function commentBadge(count: number): string {
  return `💬${count}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
