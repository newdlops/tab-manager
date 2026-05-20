import * as path from 'path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    timeout: 30_000,
    ui: 'tdd',
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.js', { cwd: testsRoot, absolute: true });
  files.sort().forEach((file) => mocha.addFile(path.resolve(file)));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
      else resolve();
    });
  });
}
