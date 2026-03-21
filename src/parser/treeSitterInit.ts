import * as vscode from 'vscode';

let Parser: any;
let SvLanguage: any;
let initialized = false;

/**
 * Initialise web-tree-sitter with the SystemVerilog WASM grammar.
 * Returns the ready-to-use Parser instance, or `undefined` if the grammar
 * WASM is not bundled (in which case we fall back to pure regex).
 */
export async function initTreeSitter(
  extensionUri: vscode.Uri,
): Promise<any | undefined> {
  if (initialized) {
    return Parser ? new Parser() : undefined;
  }

  try {
    // web-tree-sitter ships a CJS module that we can require at runtime.
    const TreeSitter = require('web-tree-sitter');

    const wasmPath = vscode.Uri.joinPath(extensionUri, 'dist', 'tree-sitter.wasm').fsPath;
    await TreeSitter.init({
      locateFile: () => wasmPath,
    });

    Parser = TreeSitter;

    // Try loading the SystemVerilog grammar
    const grammarPath = vscode.Uri.joinPath(
      extensionUri,
      'dist',
      'tree-sitter-systemverilog.wasm',
    ).fsPath;

    try {
      SvLanguage = await TreeSitter.Language.load(grammarPath);
    } catch {
      // Grammar WASM not found — that's fine, we will regex-only.
      console.warn('[uvm-assistant] tree-sitter-systemverilog.wasm not found, using regex fallback.');
      SvLanguage = undefined;
    }

    initialized = true;

    if (SvLanguage) {
      const p = new TreeSitter();
      p.setLanguage(SvLanguage);
      return p;
    }
    return undefined;
  } catch (e) {
    console.warn('[uvm-assistant] web-tree-sitter init failed, falling back to regex:', e);
    initialized = true;
    return undefined;
  }
}

