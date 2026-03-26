import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { UvmNode, TlmPort, TlmConnection, DutInfo, TestbenchProject } from '../models/uvmNode';
import { OverrideConfig } from '../models/overrides';
import { saveOverrides } from '../overrideManager';

export type DiagramMode = 'block' | 'dataflow';

export class UvmDiagramPanel {
  private static panels = new Map<DiagramMode, UvmDiagramPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private pendingData: DiagramPayload | undefined;
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
      async (msg) => {
        if (msg.command === 'ready') {
          this.flushPendingData();
        } else if (msg.command === 'openFile' && msg.filePath && msg.line) {
          const uri = vscode.Uri.file(msg.filePath);
          const line = Math.max(0, msg.line - 1);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(line, 0, line, 0),
          });
        } else if (msg.command === 'saveOverrides' && msg.overrides) {
          await saveOverrides(msg.overrides as OverrideConfig);
          // Echo back the saved overrides so the webview can re-apply
          this.panel.webview.postMessage({ command: 'overridesUpdated', overrides: msg.overrides });
        }
      },
      null,
      this.disposables,
    );
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    projects: SerializedProject[],
    mode: DiagramMode = 'block',
    overrides: OverrideConfig = {},
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const existing = UvmDiagramPanel.panels.get(mode);

    if (existing) {
      existing.panel.reveal(column);
      existing.updateDiagram(projects, overrides);
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
    instance.updateDiagram(projects, overrides);
  }

  updateDiagram(projects: SerializedProject[], overrides: OverrideConfig = {}): void {
    this.pendingData = { projects, overrides };
    this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  private flushPendingData(): void {
    if (this.pendingData) {
      this.panel.webview.postMessage({
        command: 'renderDiagram',
        projects: this.pendingData.projects,
        overrides: this.pendingData.overrides,
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
    <select id="project-dropdown" style="display:none;"></select>
    <button id="btn-zoom-in" title="Zoom In">+</button>
    <button id="btn-zoom-out" title="Zoom Out">&minus;</button>
    <button id="btn-reset" title="Reset View">&odot;</button>
    <span class="toolbar-sep"></span>
    <button id="btn-mapping" title="Toggle Mapping Table">&#9776; Mapping</button>
  </div>
  <div id="diagram-container">
    <svg id="diagram"></svg>
  </div>
  <div id="legend-overlay"></div>
  <div id="mapping-panel" style="display:none;"></div>
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

export interface SerializedProject {
  name: string;
  roots: SerializedUvmNode[];
  duts: DutInfo[];
}

interface DiagramPayload {
  projects: SerializedProject[];
  overrides: OverrideConfig;
}

interface SerializedField {
  typeName: string;
  fieldName: string;
}

interface SerializedUvmNode {
  className: string;
  uvmType: string;
  baseClass: string;
  filePath: string;
  line: number;
  children: SerializedUvmNode[];
  fields: SerializedField[];
  tlmPorts: TlmPort[];
  connections: TlmConnection[];
  virtualIfs: string[];
}

export function serializeUvmTree(roots: UvmNode[]): SerializedUvmNode[] {
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
      fields: node.fields.map(f => ({ typeName: f.typeName, fieldName: f.fieldName })),
      tlmPorts: node.tlmPorts,
      connections: node.connections,
      virtualIfs: node.virtualIfs,
    };
  }
  return roots.map(serialize).filter((n): n is SerializedUvmNode => n !== null);
}
