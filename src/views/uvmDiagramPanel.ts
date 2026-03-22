import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { UvmNode, TlmPort, TlmConnection } from '../models/uvmNode';

export type DiagramMode = 'block' | 'dataflow';

export class UvmDiagramPanel {
  private static panels = new Map<DiagramMode, UvmDiagramPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private pendingData: SerializedUvmNode[] | undefined;
  private readonly mode: DiagramMode;

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
    mode: DiagramMode,
  ) {
    this.panel = panel;
    this.mode = mode;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

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

  static createOrShow(extensionUri: vscode.Uri, uvmRoots: UvmNode[], mode: DiagramMode = 'block'): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const existing = UvmDiagramPanel.panels.get(mode);

    if (existing) {
      existing.panel.reveal(column);
      existing.updateDiagram(uvmRoots);
      return;
    }

    const title = mode === 'block' ? 'UVM Block Diagram' : 'UVM Data Flow Diagram';
    const viewType = mode === 'block' ? 'uvmBlockDiagram' : 'uvmDataFlowDiagram';

    const panel = vscode.window.createWebviewPanel(
      viewType,
      title,
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

    const instance = new UvmDiagramPanel(panel, extensionUri, mode);
    UvmDiagramPanel.panels.set(mode, instance);
    instance.updateDiagram(uvmRoots);
  }

  updateDiagram(uvmRoots: UvmNode[]): void {
    this.pendingData = serializeUvmTree(uvmRoots);
        this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  private flushPendingData(): void {
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

    const scriptFile = this.mode === 'block' ? 'blockDiagram.js' : 'diagram.js';
    const cssFile = this.mode === 'block' ? 'blockDiagram.css' : 'diagram.css';
    const title = this.mode === 'block' ? 'UVM Block Diagram' : 'UVM Data Flow Diagram';

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', scriptFile),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', cssFile),
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
  <title>${title}</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-zoom-in" title="Zoom In">+</button>
    <button id="btn-zoom-out" title="Zoom Out">&minus;</button>
    <button id="btn-reset" title="Reset View">&odot;</button>
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
    UvmDiagramPanel.panels.delete(this.mode);
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
  tlmPorts: TlmPort[];
  connections: TlmConnection[];
}

function serializeUvmTree(roots: UvmNode[]): SerializedUvmNode[] {
  const visited = new Set<string>();
  function serialize(node: UvmNode): SerializedUvmNode | null {
    if (visited.has(node.className)) { return null; }
    visited.add(node.className);
    return {
      className: node.className,
      uvmType: node.uvmType,
      baseClass: node.baseClass,
      filePath: node.filePath,
      line: node.line,
      children: node.children.map(serialize).filter((n): n is SerializedUvmNode => n !== null),
      tlmPorts: node.tlmPorts,
      connections: node.connections,
    };
  }
  return roots.map(serialize).filter((n): n is SerializedUvmNode => n !== null);
}
