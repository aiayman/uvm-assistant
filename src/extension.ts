import * as vscode from 'vscode';
import { FileScanner } from './fileScanner';
import { SvParser, ParseResult } from './parser/svParser';
import { ModuleHierarchyProvider } from './views/moduleHierarchyProvider';
import { UvmClassProvider } from './views/uvmClassProvider';
import { UvmDiagramPanel } from './views/uvmDiagramPanel';
import { runUvmLinter, toVscodeSeverity } from './linter/uvmLinter';
import { VeribleFormattingProvider } from './formatter/veribleFormatter';

let fileScanner: FileScanner;
let svParser: SvParser;
let moduleProvider: ModuleHierarchyProvider;
let uvmProvider: UvmClassProvider;
let lastResult: ParseResult | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const extensionUri = context.extensionUri;

  // Initialise components
  fileScanner = new FileScanner();
  svParser = new SvParser();
  moduleProvider = new ModuleHierarchyProvider(extensionUri);
  uvmProvider = new UvmClassProvider(extensionUri);
  diagnosticCollection = vscode.languages.createDiagnosticCollection('uvm-assistant');
  context.subscriptions.push(diagnosticCollection);

  // Register tree views
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('moduleHierarchy', moduleProvider),
    vscode.window.registerTreeDataProvider('uvmClassHierarchy', uvmProvider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('uvm-assistant.refresh', () => runAnalysis(extensionUri)),
    vscode.commands.registerCommand('uvm-assistant.openBlockDiagram', () => {
      if (lastResult) {
        UvmDiagramPanel.createOrShow(extensionUri, lastResult.uvmRoots, 'block');
      } else {
        vscode.window.showInformationMessage('UVM-Assistant: Run analysis first (click Refresh).');
      }
    }),
    vscode.commands.registerCommand('uvm-assistant.openDataFlowDiagram', () => {
      if (lastResult) {
        UvmDiagramPanel.createOrShow(extensionUri, lastResult.uvmRoots, 'dataflow');
      } else {
        vscode.window.showInformationMessage('UVM-Assistant: Run analysis first (click Refresh).');
      }
    }),
    vscode.commands.registerCommand('uvm-assistant.formatDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await vscode.commands.executeCommand('editor.action.formatDocument');
      }
    }),
  );

  // Register Verible formatter
  VeribleFormattingProvider.register(context);

  // Watch for file changes → auto-refresh (debounced to avoid concurrent analyses)
  const watcher = fileScanner.startWatching();
  context.subscriptions.push(watcher);
  fileScanner.onDidChange(() => {
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runAnalysis(extensionUri);
    }, 500);
  });

  // Init tree-sitter (non-blocking, falls back to regex on failure)
  await svParser.init(extensionUri);

  // Run initial analysis
  await runAnalysis(extensionUri);
}

async function runAnalysis(extensionUri: vscode.Uri): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'UVM-Assistant: Analyzing workspace…',
    },
    async () => {
      const files = await fileScanner.scanWorkspace();

      if (files.length === 0) {
        moduleProvider.update([], new Map());
        uvmProvider.update([]);
        diagnosticCollection.clear();
        lastResult = undefined;
        return;
      }

      const result = await svParser.parseWorkspace(files);
      lastResult = result;

      moduleProvider.update(result.moduleRoots, result.allModules);
      uvmProvider.update(result.uvmRoots);

      // ── UVM Linter (reuses file texts already read by the parser) ──
      diagnosticCollection.clear();
      const lintResults = runUvmLinter(result.fileTexts);
      for (const [filePath, diags] of lintResults) {
        const uri = vscode.Uri.file(filePath);
        const vsDiags = diags.map((d) => {
          const range = new vscode.Range(
            Math.max(0, d.line - 1), 0,
            Math.max(0, d.line - 1), Number.MAX_SAFE_INTEGER,
          );
          const vd = new vscode.Diagnostic(range, d.message, toVscodeSeverity(d.severity));
          vd.source = 'UVM-Assistant';
          vd.code = d.ruleId;
          return vd;
        });
        diagnosticCollection.set(uri, vsDiags);
      }
    },
  );
}

export function deactivate(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); }
  fileScanner?.dispose();
  diagnosticCollection?.dispose();
}
