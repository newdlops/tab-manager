import * as vscode from 'vscode';
import { spawn } from 'child_process';

/**
 * Reads and writes the native OS clipboard's *file* contents.
 *
 * VS Code's `vscode.env.clipboard` only exposes plain text, so files copied in
 * Finder (macOS), File Explorer (Windows), a Linux file manager, or another
 * VS Code window are invisible to it. This module bridges that gap by shelling
 * out to platform tools that can read/write the clipboard's file references:
 *
 * - macOS  — `osascript -l JavaScript` driving `NSPasteboard`
 * - Windows — PowerShell `Get-Clipboard`/`Set-Clipboard -Format FileDropList`
 * - Linux  — `wl-paste`/`wl-copy` (Wayland) or `xclip` (X11)
 *
 * Every call is best-effort: unavailable tools, timeouts, or errors resolve to
 * an empty result (read) or `false` (write) rather than throwing.
 */

interface RunResult {
  stdout: string;
  ok: boolean;
}

function run(command: string, args: string[], input?: string, timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ stdout: '', ok: false });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ stdout: '', ok: false });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', () => finish({ stdout: '', ok: false }));
    child.on('close', (code) => finish({ stdout, ok: code === 0 }));

    if (input !== undefined) {
      child.stdin?.on('error', () => {
        /* ignore EPIPE when the child exits early */
      });
      child.stdin?.end(input);
    }
  });
}

function parsePathList(text: string): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `x-special/gnome-copied-files` prefixes the list with a `copy`/`cut` verb.
    if (line === 'copy' || line === 'cut') continue;
    const uri = lineToUri(line);
    if (!uri) continue;
    const key = uri.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    uris.push(uri);
  }
  return uris;
}

function lineToUri(line: string): vscode.Uri | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    try {
      const uri = vscode.Uri.parse(line);
      return uri.scheme === 'file' ? uri : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return vscode.Uri.file(line);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

const MAC_READ_SCRIPT = `
ObjC.import('AppKit');
(function () {
  var pb = $.NSPasteboard.generalPasteboard;
  var out = [];

  // VS Code stores Explorer resources in a private newline-delimited URI
  // format. Reading it preserves the complete selection copied by another
  // VS Code window, even when no native file URL representation is present.
  try {
    var codeData = pb.dataForType($('code/file-list'));
    if (codeData.length > 0) {
      var codeText = ObjC.unwrap(
        $.NSString.alloc.initWithDataEncoding(codeData, $.NSUTF8StringEncoding)
      );
      if (typeof codeText === 'string' && codeText.length > 0) {
        out.push(codeText);
      }
    }
  } catch (e) {}

  var classes = $.NSArray.arrayWithObject($.NSURL);
  var urls = pb.readObjectsForClassesOptions(classes, $());
  try {
    var n = urls.count;
    for (var i = 0; i < n; i++) {
      var u = urls.objectAtIndex(i);
      if (u.isFileURL) { out.push(ObjC.unwrap(u.path)); }
    }
  } catch (e) {}
  return out.join('\\n');
})();
`;

const MAC_WRITE_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var payload = JSON.parse(argv[0]);
  var paths = payload.paths;
  var resources = payload.resources;
  var pb = $.NSPasteboard.generalPasteboard;
  var filenamesType = $('NSFilenamesPboardType');
  var codeFileListType = $('code/file-list');
  var types = $.NSMutableArray.alloc.init;
  types.addObject(filenamesType);
  types.addObject(codeFileListType);
  var pathList = $.NSMutableArray.alloc.init;
  for (var i = 0; i < paths.length; i++) {
    pathList.addObject($(paths[i]));
  }
  var codeData = $(resources).dataUsingEncoding($.NSUTF8StringEncoding);

  pb.clearContents;
  pb.declareTypesOwner(types, $());
  var wroteFiles = pb.setPropertyListForType(pathList, filenamesType);
  var wroteCodeFileList = pb.setDataForType(codeData, codeFileListType);
  return wroteFiles && wroteCodeFileList ? 'ok' : 'fail';
}
`;

async function readMac(): Promise<vscode.Uri[]> {
  // Passing JXA source via `-e` is required for the Objective-C bridge to
  // resolve NSPasteboard selectors reliably.
  const result = await run('osascript', ['-l', 'JavaScript', '-e', MAC_READ_SCRIPT]);
  return result.ok ? parsePathList(result.stdout) : [];
}

async function writeMac(paths: string[]): Promise<boolean> {
  const payload = JSON.stringify({
    paths,
    resources: paths.map((path) => vscode.Uri.file(path).toString()).join('\n'),
  });
  const result = await run('osascript', [
    '-l',
    'JavaScript',
    '-e',
    MAC_WRITE_SCRIPT,
    '--',
    payload,
  ]);
  return result.ok && result.stdout.includes('ok');
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function readWindows(): Promise<vscode.Uri[]> {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-Clipboard -Format FileDropList | ForEach-Object { $_.ToString() }',
  ]);
  return result.ok ? parsePathList(result.stdout) : [];
}

async function writeWindows(paths: string[]): Promise<boolean> {
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Set-Clipboard -Path @(${list})`,
  ]);
  return result.ok;
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

async function readLinux(): Promise<vscode.Uri[]> {
  const attempts: Array<[string, string[]]> = [
    ['wl-paste', ['--no-newline', '--type', 'text/uri-list']],
    ['wl-paste', ['--no-newline', '--type', 'x-special/gnome-copied-files']],
    ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o']],
    ['xclip', ['-selection', 'clipboard', '-t', 'x-special/gnome-copied-files', '-o']],
  ];
  for (const [command, args] of attempts) {
    const result = await run(command, args);
    if (!result.ok) continue;
    const uris = parsePathList(result.stdout);
    if (uris.length > 0) return uris;
  }
  return [];
}

async function writeLinux(paths: string[]): Promise<boolean> {
  const content = `copy\n${paths.map((p) => vscode.Uri.file(p).toString()).join('\n')}`;
  const attempts: Array<[string, string[]]> = [
    ['wl-copy', ['--type', 'x-special/gnome-copied-files']],
    ['xclip', ['-selection', 'clipboard', '-t', 'x-special/gnome-copied-files', '-i']],
  ];
  for (const [command, args] of attempts) {
    const result = await run(command, args, content);
    if (result.ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the file URIs currently on the native OS clipboard (empty when none). */
export async function readClipboardFileUris(): Promise<vscode.Uri[]> {
  try {
    switch (process.platform) {
      case 'darwin':
        return await readMac();
      case 'win32':
        return await readWindows();
      case 'linux':
        return await readLinux();
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/**
 * Places the given file URIs on the native OS clipboard so they can be pasted in
 * Finder / File Explorer / another VS Code window. Returns `true` on success.
 */
export async function writeClipboardFileUris(uris: readonly vscode.Uri[]): Promise<boolean> {
  const paths = uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
  if (paths.length === 0) return false;
  try {
    switch (process.platform) {
      case 'darwin':
        return await writeMac(paths);
      case 'win32':
        return await writeWindows(paths);
      case 'linux':
        return await writeLinux(paths);
      default:
        return false;
    }
  } catch {
    return false;
  }
}
