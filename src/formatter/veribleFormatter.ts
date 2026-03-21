import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const SV_SELECTOR: vscode.DocumentSelector = [
  { language: 'systemverilog', scheme: 'file' },
  { language: 'verilog', scheme: 'file' },
];

/** Resolve the verible-verilog-format binary: bundled first, then user setting, then PATH. */
function resolveVeriblePath(extensionPath: string, configPath: string): string {
  const bundled = path.join(extensionPath, 'bin', 'verible-verilog-format');
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return configPath;
}

export class VeribleFormattingProvider
  implements
    vscode.DocumentFormattingEditProvider,
    vscode.DocumentRangeFormattingEditProvider
{
  private readonly extensionPath: string;

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }
  // ── Document formatting ──────────────────────────────────────────

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.runVerible(document, token);
  }

  // ── Range formatting ─────────────────────────────────────────────

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.runVerible(document, token, range);
  }

  // ── Core logic ───────────────────────────────────────────────────

  private runVerible(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    range?: vscode.Range,
  ): Promise<vscode.TextEdit[]> {
    const config = vscode.workspace.getConfiguration('uvm-assistant.verible');
    const configPath = config.get<string>('path', 'verible-verilog-format');
    const veriblePath = resolveVeriblePath(this.extensionPath, configPath);
    const columnLimit = config.get<number>('columnLimit', 100);
    const alignment = config.get<string>('portDeclarationsAlignment', 'infer');
    const wrapLong = config.get<boolean>('tryWrapLongLines', true);

    const args: string[] = [
      '-',
      `--column_limit=${columnLimit}`,
      `--port_declarations_alignment=${alignment}`,
    ];
    if (wrapLong) {
      args.push('--try_wrap_long_lines');
    }
    if (range) {
      args.push(`--lines=${range.start.line + 1}-${range.end.line + 1}`);
    }

    return new Promise<vscode.TextEdit[]>((resolve, reject) => {
      const proc = spawn(veriblePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      token.onCancellationRequested(() => {
        proc.kill();
        resolve([]);
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          vscode.window.showErrorMessage(
            `Verible formatter not found at '${veriblePath}'. ` +
              'Install it or set "uvm-assistant.verible.path" in settings.',
          );
          resolve([]);
        } else {
          reject(err);
        }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          const msg = stderr.trim() || `verible-verilog-format exited with code ${code}`;
          vscode.window.showWarningMessage(`Verible: ${msg}`);
          resolve([]);
          return;
        }
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        );
        resolve([vscode.TextEdit.replace(fullRange, stdout)]);
      });

      proc.stdin.end(document.getText());
    });
  }

  // ── Registration helper ──────────────────────────────────────────

  static register(context: vscode.ExtensionContext): void {
    const provider = new VeribleFormattingProvider(context.extensionPath);
    context.subscriptions.push(
      vscode.languages.registerDocumentFormattingEditProvider(SV_SELECTOR, provider),
      vscode.languages.registerDocumentRangeFormattingEditProvider(SV_SELECTOR, provider),
    );
  }
}
