import * as vscode from 'vscode';

const SV_GLOB = '**/*.{sv,v,svh,vh}';

export class FileScanner {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private svWatcher: vscode.FileSystemWatcher | undefined;
  private gitignoreWatcher: vscode.FileSystemWatcher | undefined;

  async scanWorkspace(): Promise<vscode.Uri[]> {
    const allFiles = await vscode.workspace.findFiles(SV_GLOB);
    return filterByGitignore(allFiles);
  }

  startWatching(): vscode.Disposable {
    this.svWatcher?.dispose();
    this.gitignoreWatcher?.dispose();

    this.svWatcher = vscode.workspace.createFileSystemWatcher(SV_GLOB);
    this.gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');

    const fire = () => this._onDidChange.fire();
    this.svWatcher.onDidCreate(fire);
    this.svWatcher.onDidChange(fire);
    this.svWatcher.onDidDelete(fire);
    this.gitignoreWatcher.onDidCreate(fire);
    this.gitignoreWatcher.onDidChange(fire);
    this.gitignoreWatcher.onDidDelete(fire);

    return {
      dispose: () => {
        this.svWatcher?.dispose();
        this.gitignoreWatcher?.dispose();
      },
    };
  }

  dispose(): void {
    this.svWatcher?.dispose();
    this.gitignoreWatcher?.dispose();
    this._onDidChange.dispose();
  }
}

// ─── .gitignore support ─────────────────────────────────────────────

interface GitignoreRule {
  pattern: RegExp;
  negated: boolean;
}

/**
 * Post-filter a file list by .gitignore rules from each workspace folder.
 * The default `files.exclude` behaviour of `findFiles` is preserved;
 * .gitignore filtering is applied on top.
 */
async function filterByGitignore(files: vscode.Uri[]): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { return files; }

  const matchers: { root: string; rules: GitignoreRule[] }[] = [];

  for (const folder of folders) {
    const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
    try {
      const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
      const text = Buffer.from(bytes).toString('utf-8');
      const rules = parseGitignoreRules(text);
      if (rules.length > 0) {
        matchers.push({ root: folder.uri.fsPath, rules });
      }
    } catch {
      // No .gitignore in this folder – nothing to exclude
    }
  }

  if (matchers.length === 0) { return files; }

  return files.filter(uri => {
    const fsPath = uri.fsPath;
    for (const { root, rules } of matchers) {
      if (fsPath.startsWith(root + '/') || fsPath.startsWith(root + '\\')) {
        const rel = fsPath.slice(root.length + 1);
        if (isIgnored(rel, rules)) { return false; }
      }
    }
    return true;
  });
}

/**
 * Parse .gitignore content into an ordered list of rules.
 * Supports comments, blank lines, negation (`!`), directory-only
 * patterns (trailing `/`), rooted patterns (leading `/` or embedded `/`),
 * and glob wildcards (`*`, `**`, `?`).
 */
function parseGitignoreRules(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];

  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) { continue; }

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }

    rules.push({ pattern: gitignorePatternToRegex(line), negated });
  }

  return rules;
}

/**
 * Convert a single .gitignore pattern to a RegExp that tests against
 * relative file paths (forward-slash separated).
 */
function gitignorePatternToRegex(raw: string): RegExp {
  const isDirOnly = raw.endsWith('/');
  let pattern = isDirOnly ? raw.slice(0, -1) : raw;

  const isRooted = pattern.startsWith('/');
  if (isRooted) { pattern = pattern.slice(1); }

  // An unrooted pattern with no internal slash matches any path component
  const hasSlash = pattern.includes('/');

  // Build regex character-by-character to correctly handle globs
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';   // **/ = zero or more directories
        i += 2;             // skip past **/
      } else {
        re += '.*';         // ** = match everything
        i += 1;             // skip second *
      }
    } else if (pattern[i] === '*') {
      re += '[^/]*';
    } else if (pattern[i] === '?') {
      re += '[^/]';
    } else {
      re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  if (!isRooted && !hasSlash) {
    // Unanchored – can match as any path component
    re = `(?:^|/)${re}(?:/|$)`;
  } else {
    // Anchored to repo root
    re = `^${re}(?:/|$)`;
  }

  return new RegExp(re);
}

/**
 * Test a relative path against an ordered list of gitignore rules.
 * Last matching rule wins (negation can un-ignore a file).
 */
function isIgnored(relativePath: string, rules: GitignoreRule[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  let ignored = false;
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}
