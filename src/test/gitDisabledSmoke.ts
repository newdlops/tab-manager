import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FilterSource } from '../filterSource';
import type { ComparisonSource } from '../comparisonSource';
import type { ExplorerProvider } from '../explorerProvider';
import type { PullRequestCommentDecorationProvider } from '../pullRequestComments';
import { parsePorcelainStatus } from '../gitRepositoryCli';

interface TestApi {
  filterSource: FilterSource;
  comparisonSource: ComparisonSource;
  explorerProvider: ExplorerProvider;
  pullRequestCommentDecorations: PullRequestCommentDecorationProvider;
  store: { setFilterMode(mode: 'none' | 'modified' | 'untracked' | 'deleted' | 'prFiles'): Promise<void> };
}

/** 늦은 CLI·watcher 결과를 기다리고 실패 시 의미 있는 검증 이름을 보존한다. */
async function waitFor(label: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

/** GitHub HTTPS에 fixture 응답만 주입하고 확장 자체의 PR 조회·필터·장식 코드는 그대로 실행한다. */
function mockGithubRequests(): { urls: string[]; dispose(): void } {
  const https = require('node:https') as { request: typeof import('node:https').request };
  const original = https.request;
  const urls: string[] = [];
  const replacement = (raw: string | URL, options: unknown, callback: (value: unknown) => void) => {
    const url = new URL(String(raw));
    if (url.hostname !== 'api.github.com' || !url.pathname.startsWith('/repos/gsc-fixture/tab-repo/pulls')) {
      return (original as Function)(raw, options, callback);
    }
    urls.push(url.toString());
    const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: object };
    response.statusCode = 200;
    response.headers = {};
    const request = new EventEmitter() as EventEmitter & {
      setTimeout(): typeof request; end(): void; write(): void; destroy(error?: Error): void;
    };
    request.setTimeout = () => request;
    request.write = () => {};
    request.destroy = error => { if (error) request.emit('error', error); };
    request.end = () => queueMicrotask(() => {
      const value = url.pathname.endsWith('/comments') ? [{ path: 'modified.txt' }] :
        url.pathname.endsWith('/files') ? [
          { filename: 'modified.txt', status: 'modified' }, { filename: 'deleted.txt', status: 'removed' },
        ] : [{ number: 7, head: { ref: 'feature/git-disabled', repo: { owner: { login: 'gsc-fixture' } } } }];
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify(value)));
      response.emit('end');
    });
    return request;
  };
  https.request = replacement as unknown as typeof https.request;
  return { urls, dispose: () => { https.request = original; } };
}

/** NUL 상태·branch 파싱의 경계를 검증해 rename 원본이 가짜 변경 파일로 섞이지 않게 한다. */
function verifyStatusParser(): void {
  const parsed = parsePorcelainStatus(
    '## feature/test...origin/feature/test [ahead 1]\0 M line\nname.txt\0R  renamed.txt\0old.txt\0 D gone.txt\0?? new.txt\0',
    [{ name: 'origin', fetchUrl: 'https://github.com/gsc-fixture/tab-repo.git' }],
  );
  assert.equal(parsed.branch?.name, 'feature/test');
  assert.equal(parsed.branch?.upstream?.remote, 'origin');
  assert.deepEqual(parsed.changes, [
    { path: 'line\nname.txt', status: 5 }, { path: 'gone.txt', status: 6 }, { path: 'new.txt', status: 7 },
  ]);
  assert.equal(parsePorcelainStatus('## HEAD (no branch)\0', []).branch, undefined);
  assert.equal(parsePorcelainStatus('## No commits yet on main\0', []).branch?.name, 'main');
}

/** 기본 Git 비활성화·동적 전환 상태에서 실제 PR 데이터와 Explorer 항목을 끝까지 검증한다. */
export async function run(): Promise<void> {
  verifyStatusParser();
  const root = process.env.TAB_MANAGER_SMOKE_ROOT!;
  const marker = process.env.TAB_MANAGER_SMOKE_MARKER!;
  const config = vscode.workspace.getConfiguration('git', vscode.Uri.file(root));
  assert.equal(config.get('enabled'), false);
  const http = mockGithubRequests();
  try {
    const extension = vscode.extensions.getExtension<TestApi>('newdlops.tab-manager');
    assert.ok(extension, 'Tab Manager development extension must be installed');
    const api = await extension.activate();
    await api.filterSource.refresh();
    const names = (mode: 'modified' | 'untracked' | 'deleted' | 'prFiles' | 'prComments') =>
      api.filterSource.getUris(mode).map(uri => path.relative(root, uri.fsPath)).sort();
    assert.deepEqual(names('modified'), ['modified.txt', 'newline\nname.txt']);
    assert.deepEqual(names('deleted'), ['deleted.txt']);
    assert.ok(names('untracked').includes('untracked.txt'));
    assert.ok(!names('modified').includes('rename source.txt'));
    const calls = await readFile(marker, 'utf8');
    assert.match(calls, /rev-parse --show-toplevel/);
    assert.match(calls, /status --porcelain=v1/);
    await api.pullRequestCommentDecorations.refresh();
    await waitFor('PR files with native Git disabled', () => names('prFiles').length === 2);
    assert.deepEqual(names('prFiles'), ['deleted.txt', 'modified.txt']);
    assert.deepEqual(names('prComments'), ['modified.txt']);
    assert.ok(http.urls.some(value => new URL(value).searchParams.get('head') === 'gsc-fixture:feature/git-disabled'));
    assert.match(api.pullRequestCommentDecorations.provideFileDecoration(vscode.Uri.file(path.join(root, 'modified.txt')))?.tooltip ?? '', /#7/);
    await api.store.setFilterMode('prFiles');
    const nodes = await api.explorerProvider.getChildren();
    const files = nodes.filter(node => 'uri' in node);
    assert.deepEqual(files.map(node => path.basename((node as { uri: vscode.Uri }).uri.fsPath)).sort(), ['deleted.txt', 'modified.txt']);
    assert.ok(files.some(node => 'isDeleted' in node && node.isDeleted), 'Deleted PR file is an Explorer ghost item');
    console.log('PASS: PR files/comments, deleted Explorer item and working-tree filters while built-in Git is disabled.');

    // 같은 공급자 객체를 유지한 상태에서 기본 Git을 켰다가 다시 끄는 실제 설정 전환이다.
    await config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
    const builtin = vscode.extensions.getExtension<{ enabled: boolean; getAPI(version: 1): { repositories: unknown[] } }>('vscode.git')!;
    await builtin.activate();
    await waitFor('native Git repository ready', () => builtin.exports.enabled && builtin.exports.getAPI(1).repositories.length > 0);
    await new Promise(resolve => setTimeout(resolve, 600));
    const initialCalls = (await readFile(marker, 'utf8')).length;
    await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
    assert.equal(config.get('enabled'), false);
    await waitFor('CLI source restored', async () => (await readFile(marker, 'utf8')).length > initialCalls);
    await waitFor('working-tree state restored', () => names('modified').includes('modified.txt'));
    await api.filterSource.refresh();
    assert.deepEqual(names('modified'), ['modified.txt', 'newline\nname.txt']);
    await api.pullRequestCommentDecorations.refresh();
    await waitFor('PR files after native-to-CLI transition', () => names('prFiles').length === 2);

    // 실제 Explorer watcher가 열린 탭과 무관한 파일 변경을 CLI 상태 갱신에 전달하는지 확인한다.
    const extra = vscode.Uri.file(path.join(root, 'watcher-created.txt'));
    await vscode.workspace.fs.writeFile(extra, Buffer.from('created\n'));
    await waitFor('automatic filesystem refresh', () => names('untracked').includes('watcher-created.txt'));
    await vscode.workspace.fs.delete(extra);
    await waitFor('automatic filesystem delete refresh', () => !names('untracked').includes('watcher-created.txt'));
    console.log('PASS: native Git enable/disable transition and automatic create/delete refresh.');

    await new Promise(resolve => setTimeout(resolve, 1200));
    const settled = await readFile(marker, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(await readFile(marker, 'utf8'), settled, 'Idle CLI source must not poll Git');
    console.log('PASS: shared Git source stays idle without polling.');
  } finally {
    http.dispose();
    await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
  }
}
