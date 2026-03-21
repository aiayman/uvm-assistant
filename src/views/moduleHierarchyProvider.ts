import * as vscode from 'vscode';
import * as path from 'path';
import { ModuleNode } from '../models/moduleNode';

type TreeElement = ModuleNodeItem | InstanceItem;

export class ModuleHierarchyProvider implements vscode.TreeDataProvider<TreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: ModuleNode[] = [];
  private allModules = new Map<string, ModuleNode>();

  constructor(private extensionUri: vscode.Uri) {}

  update(roots: ModuleNode[], allModules: Map<string, ModuleNode>): void {
    this.roots = roots;
    this.allModules = allModules;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeElement): TreeElement[] {
    if (!element) {
      // Root level: top-level modules
      return this.roots.map(
        (m) => new ModuleNodeItem(m, this.allModules, this.extensionUri),
      );
    }

    if (element instanceof ModuleNodeItem) {
      return element.module.instances.map((inst) => {
        const resolved = this.allModules.get(inst.moduleName);
        if (resolved) {
          return new ModuleNodeItem(resolved, this.allModules, this.extensionUri);
        }
        return new InstanceItem(inst.moduleName, inst.instanceName, inst.filePath, inst.line);
      });
    }

    return [];
  }
}

class ModuleNodeItem extends vscode.TreeItem {
  constructor(
    public readonly module: ModuleNode,
    private allModules: Map<string, ModuleNode>,
    extensionUri: vscode.Uri,
  ) {
    super(
      module.name,
      module.instances.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.description = `${module.ports.length} ports, ${module.instances.length} inst`;
    this.tooltip = `${module.name} (${path.basename(module.filePath)}:${module.line})`;
    this.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'module.svg');
    this.command = {
      command: 'vscode.open',
      title: 'Open Module',
      arguments: [
        vscode.Uri.file(module.filePath),
        { selection: new vscode.Range(module.line - 1, 0, module.line - 1, 0) } as vscode.TextDocumentShowOptions,
      ],
    };
  }
}

class InstanceItem extends vscode.TreeItem {
  constructor(
    moduleName: string,
    instanceName: string,
    filePath: string,
    line: number,
  ) {
    super(`${moduleName} (${instanceName})`, vscode.TreeItemCollapsibleState.None);
    this.description = 'unresolved';
    this.tooltip = `Instance of ${moduleName} at ${path.basename(filePath)}:${line}`;
    this.command = {
      command: 'vscode.open',
      title: 'Open Instance',
      arguments: [
        vscode.Uri.file(filePath),
        { selection: new vscode.Range(line - 1, 0, line - 1, 0) } as vscode.TextDocumentShowOptions,
      ],
    };
  }
}
