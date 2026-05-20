import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(root: string, args: string[]): void {
  childProcess.execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Tab Manager E2E',
      GIT_AUTHOR_EMAIL: 'tab-manager-e2e@example.com',
      GIT_COMMITTER_NAME: 'Tab Manager E2E',
      GIT_COMMITTER_EMAIL: 'tab-manager-e2e@example.com',
    },
  });
}

function prepareWorkspace(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, 'alpha.ts', 'export const alpha = 1;\n');
  writeFile(root, 'zeta.txt', 'zeta\n');
  writeFile(root, 'notes.md', '# Notes\n');
  writeFile(root, 'modified.txt', 'committed\n');
  writeFile(root, 'delete-me.txt', 'remove me\n');
  writeFile(root, 'readonly.txt', 'readonly\n');
  writeFile(root, 'compare-left.txt', 'left\n');
  writeFile(root, 'compare-right.txt', 'right\n');
  writeFile(root, 'folder/child.txt', 'child\n');

  git(root, ['init']);
  git(root, ['config', 'user.name', 'Tab Manager E2E']);
  git(root, ['config', 'user.email', 'tab-manager-e2e@example.com']);
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial fixture']);
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-manager-e2e-workspace-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-manager-e2e-user-data-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-manager-e2e-extensions-'));

  prepareWorkspace(workspacePath);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-gpu',
        '--disable-workspace-trust',
        '--skip-release-notes',
        '--skip-welcome',
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
      ],
      extensionTestsEnv: {
        TAB_MANAGER_E2E: '1',
        TAB_MANAGER_E2E_ROOT: extensionDevelopmentPath,
        TAB_MANAGER_E2E_WORKSPACE: workspacePath,
      },
    });
  } finally {
    if (process.env.TAB_MANAGER_KEEP_E2E !== '1') {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(extensionsDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
