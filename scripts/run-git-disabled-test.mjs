// 기본 Git이 꺼진 전용 profile에서 Tab Manager의 실제 PR·Explorer 기능을 검증한다.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionRoot = process.cwd();
// macOS IPC socket의 경로 길이 제한을 피하도록 profile 루트를 짧게 만든다.
const directory = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'tm-git-smoke-')));
const workspace = path.join(directory, 'workspace');
const profile = path.join(directory, 'profile');
const marker = path.join(directory, 'git-calls.log');
const wrapper = path.join(directory, 'git wrapper with spaces');
const gitPath = process.platform === 'darwin' && existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git';

/** 테스트 설정과 Git 이력을 실제 사용자 profile·저장소에서 격리한다. */
async function prepareFixture() {
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await mkdir(path.join(profile, 'User'), { recursive: true });
  await mkdir(path.join(directory, 'hooks'));
  const git = (args) => execFileSync(gitPath, args, { cwd: workspace, stdio: 'pipe' });
  git(['-c', 'init.templateDir=', 'init', '--initial-branch=feature/git-disabled']);
  for (const [key, value] of [
    ['user.name', 'Git Disabled Smoke'], ['user.email', 'smoke@example.invalid'],
    ['commit.gpgSign', 'false'], ['core.fsmonitor', 'false'],
    ['core.hooksPath', path.join(directory, 'hooks')],
  ]) git(['config', key, value]);
  for (const name of ['modified.txt', 'deleted.txt', 'rename source.txt', 'newline\nname.txt']) {
    await writeFile(path.join(workspace, name), 'base\n');
  }
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/gsc-fixture/tab-repo.git']);
  git(['update-ref', 'refs/remotes/origin/feature/git-disabled', 'HEAD']);
  git(['config', 'branch.feature/git-disabled.remote', 'origin']);
  git(['config', 'branch.feature/git-disabled.merge', 'refs/heads/feature/git-disabled']);
  git(['mv', 'rename source.txt', 'renamed target.txt']);
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(workspace, 'deleted.txt'));
  await writeFile(path.join(workspace, 'modified.txt'), 'base\nchanged\n');
  await writeFile(path.join(workspace, 'newline\nname.txt'), 'base\nchanged\n');
  await writeFile(path.join(workspace, 'untracked.txt'), 'untracked\n');
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  if (process.platform === 'win32') throw new Error('This CLI wrapper smoke currently requires a POSIX shell.');
  await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$*" >> ' + quote(marker) + '\nexec ' + quote(gitPath) + ' "$@"\n', { mode: 0o755 });
  const settings = { 'git.enabled': false, 'git.path': gitPath, 'gitSimpleCompare.gitPath': wrapper };
  await writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings));
  await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'git.enabled': false }));
}

/** 설치된 VS Code를 우선 사용해 다운로드 없이 실제 Extension Host를 실행한다. */
async function main() {
  await prepareFixture();
  const executable = process.env.TAB_MANAGER_VSCODE_EXECUTABLE ??
    (process.platform === 'darwin' ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].find(existsSync) : undefined);
  const result = await runTests({
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'out', 'test', 'gitDisabledSmoke.js'),
    ...(executable && existsSync(executable) ? { vscodeExecutablePath: executable } : { version: '1.85.0' }),
    extensionTestsEnv: { TAB_MANAGER_E2E: '1', TAB_MANAGER_SMOKE_ROOT: workspace, TAB_MANAGER_SMOKE_MARKER: marker },
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--disable-workspace-trust',
      '--user-data-dir=' + profile, '--extensions-dir=' + path.join(directory, 'extensions')],
  });
  if (result !== 0) process.exitCode = result;
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => console.log('Isolated test profile and diagnostics: ' + directory));
