import * as vscode from 'vscode';
import * as path from 'path';
import { OverrideConfig } from './models/overrides';

const CONFIG_FILENAME = '.uvm-assistant.json';

/**
 * Find the workspace root directory.
 * Returns the first workspace folder or undefined.
 */
function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Load override config from .uvm-assistant.json in the workspace root.
 * Returns an empty config if the file doesn't exist or can't be parsed.
 */
export async function loadOverrides(): Promise<OverrideConfig> {
  const root = getWorkspaceRoot();
  if (!root) return {};

  const configPath = path.join(root, CONFIG_FILENAME);
  const uri = vscode.Uri.file(configPath);

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf-8');
    const parsed = JSON.parse(text);
    return parsed as OverrideConfig;
  } catch {
    return {};
  }
}

/**
 * Save override config to .uvm-assistant.json in the workspace root.
 */
export async function saveOverrides(config: OverrideConfig): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('No workspace folder open — cannot save overrides.');
    return;
  }

  // Strip empty arrays/objects to keep the file clean
  const clean: Record<string, unknown> = {};
  if (config.addedComponents && config.addedComponents.length > 0) clean.addedComponents = config.addedComponents;
  if (config.removedComponents && config.removedComponents.length > 0) clean.removedComponents = config.removedComponents;
  if (config.roleOverrides && Object.keys(config.roleOverrides).length > 0) clean.roleOverrides = config.roleOverrides;
  if (config.addedConnections && config.addedConnections.length > 0) clean.addedConnections = config.addedConnections;
  if (config.removedConnections && config.removedConnections.length > 0) clean.removedConnections = config.removedConnections;

  const configPath = path.join(root, CONFIG_FILENAME);
  const uri = vscode.Uri.file(configPath);
  const content = JSON.stringify(clean, null, 2) + '\n';

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}
