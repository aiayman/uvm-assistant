import * as vscode from 'vscode';

const SV_GLOB = '**/*.{sv,v,svh,vh}';

export class FileScanner {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher: vscode.FileSystemWatcher | undefined;

  async scanWorkspace(): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(SV_GLOB);
  }

  startWatching(): vscode.Disposable {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(SV_GLOB);
    const fire = () => this._onDidChange.fire();
    this.watcher.onDidCreate(fire);
    this.watcher.onDidChange(fire);
    this.watcher.onDidDelete(fire);
    return this.watcher;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
