import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { UvmNode } from '../models/uvmNode';

export class UvmDiagramPanel {
  private static currentPanel: UvmDiagramPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private pendingData: SerializedUvmNode[] | undefined;
  private webviewReady = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.command === 'ready') {
          this.flushPendingData();
        } else if (msg.command === 'openFile' && msg.filePath && msg.line) {
          const uri = vscode.Uri.file(msg.filePath);
          const line = Math.max(0, msg.line - 1);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(line, 0, line, 0),
          });
        }
      },
      null,
      this.disposables,
    );
  }

  static createOrShow(extensionUri: vscode.Uri, uvmRoots: UvmNode[]): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (UvmDiagramPanel.currentPanel) {
      UvmDiagramPanel.currentPanel.panel.reveal(column);
      UvmDiagramPanel.currentPanel.updateDiagram(uvmRoots);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'uvmAssistantDiagram',
      'UVM Block Diagram',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(extensionUri, 'resources'),
        ],
        retainContextWhenHidden: true,
      },
    );

    UvmDiagramPanel.currentPanel = new UvmDiagramPanel(panel, extensionUri);
    UvmDiagramPanel.currentPanel.updateDiagram(uvmRoots);
  }

  updateDiagram(uvmRoots: UvmNode[]): void {
    this.pendingData = serializeUvmTree(uvmRoots);
    this.webviewReady = false;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    // Data is sent when the webview posts its 'ready' message
  }

  private flushPendingData(): void {
    this.webviewReady = true;
    if (this.pendingData) {
      this.panel.webview.postMessage({
        command: 'renderDiagram',
        data: this.pendingData,
      });
      this.pendingData = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'diagram.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'diagram.css'),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'nonce-${nonce}';
      script-src 'nonce-${nonce}';
      img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>UVM Block Diagram</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-zoom-in" title="Zoom In">+</button>
    <button id="btn-zoom-out" title="Zoom Out">−</button>
    <button id="btn-reset" title="Reset View">⊙</button>
  </div>
  <div id="diagram-container">
    <svg id="diagram"></svg>
  </div>
  <div id="empty-state" style="display:none;">
    <p>No UVM components found in the workspace.</p>
    <p>Open a folder containing SystemVerilog files with UVM classes and click Refresh.</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    UvmDiagramPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

interface SerializedUvmNode {
  className: string;
  uvmType: string;
  baseClass: string;
  filePath: string;
  line: number;
  children: SerializedUvmNode[];
}

function serializeUvmTree(roots: UvmNode[]): SerializedUvmNode[] {
  const visited = new Set<string>();
  function serialize(node: UvmNode): SerializedUvmNode | null {
    if (visited.has(node.className)) { return null; } // prevent cycles
    visited.add(node.className);
    return {
      className: node.className,
      uvmType: node.uvmType,
      baseClass: node.baseClass,
      filePath: node.filePath,
      line: node.line,
      children: node.children.map(serialize).filter((n): n is SerializedUvmNode => n !== null),
    };
  }
  return roots.map(serialize).filter((n): n is SerializedUvmNode => n !== null);
}
