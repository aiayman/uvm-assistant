import * as vscode from 'vscode';
import * as path from 'path';
import { UvmNode } from '../models/uvmNode';
import { uvmTypeIcon } from '../utils/uvmClassifier';

export class UvmClassProvider implements vscode.TreeDataProvider<UvmTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<UvmTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: UvmNode[] = [];

  constructor(private extensionUri: vscode.Uri) {}

  update(roots: UvmNode[]): void {
    this.roots = roots;
    this._onDidChangeTreeData.fire(undefined);
  }

  getRoots(): UvmNode[] {
    return this.roots;
  }

  getTreeItem(element: UvmTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: UvmTreeItem): UvmTreeItem[] {
    if (!element) {
      return this.roots.map((n) => new UvmTreeItem(n, this.extensionUri));
    }
    return element.node.children.map((n) => new UvmTreeItem(n, this.extensionUri));
  }
}

class UvmTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: UvmNode,
    extensionUri: vscode.Uri,
  ) {
    super(
      node.className,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.description = `[${node.uvmType}] extends ${node.baseClass}`;
    this.tooltip = `${node.className} : ${node.baseClass}\n${path.basename(node.filePath)}:${node.line}`;
    this.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', `${uvmTypeIcon(node.uvmType)}.svg`);
    this.command = {
      command: 'vscode.open',
      title: 'Open Class',
      arguments: [
        vscode.Uri.file(node.filePath),
        { selection: new vscode.Range(node.line - 1, 0, node.line - 1, 0) } as vscode.TextDocumentShowOptions,
      ],
    };
  }
}
