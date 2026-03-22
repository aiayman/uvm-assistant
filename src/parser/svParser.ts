import * as vscode from 'vscode';
import { ModuleNode, ModuleInstance } from '../models/moduleNode';
import { UvmClassInfo, UvmNode } from '../models/uvmNode';
import { initTreeSitter } from './treeSitterInit';
import { regexParse } from './regexFallback';
import { classifyUvmBase } from '../utils/uvmClassifier';
export interface ParseResult {
  /** Top-level modules (not instantiated by any other module) */
  moduleRoots: ModuleNode[];
  /** All modules keyed by name */
  allModules: Map<string, ModuleNode>;
  /** UVM class tree roots (uvm_test / uvm_env classes) */
  uvmRoots: UvmNode[];
  /** All UVM classes keyed by class name */
  allUvmClasses: Map<string, UvmClassInfo>;
  /** Raw file texts keyed by fsPath, so downstream consumers don't re-read */
  fileTexts: Map<string, string>;
}

export class SvParser {
  private treeSitterParser: any | undefined;

  async init(extensionUri: vscode.Uri): Promise<void> {
    this.treeSitterParser = await initTreeSitter(extensionUri);
  }

  /**
   * Parse all SV files in the workspace and build both hierarchies.
   */
  async parseWorkspace(files: vscode.Uri[]): Promise<ParseResult> {
    const allModules = new Map<string, ModuleNode>();
    const allUvmClasses = new Map<string, UvmClassInfo>();
    const fileTexts = new Map<string, string>();

    for (const uri of files) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf-8');
        const filePath = uri.fsPath;
        fileTexts.set(filePath, text);

        let parsed: { modules: ModuleNode[]; uvmClasses: UvmClassInfo[] };

        if (this.treeSitterParser) {
          parsed = this.parseWithTreeSitter(text, filePath);
        } else {
          parsed = regexParse(text, filePath);
        }

        for (const mod of parsed.modules) {
          allModules.set(mod.name, mod);
        }
        for (const cls of parsed.uvmClasses) {
          allUvmClasses.set(cls.className, cls);
        }
      } catch (e) {
        console.warn(`[uvm-assistant] Failed to parse ${uri.fsPath}:`, e);
      }
    }

    const moduleRoots = buildModuleHierarchy(allModules);
    const uvmRoots = buildUvmHierarchy(allUvmClasses);

    return { moduleRoots, allModules, uvmRoots, allUvmClasses, fileTexts };
  }

  private parseWithTreeSitter(
    text: string,
    filePath: string,
  ): { modules: ModuleNode[]; uvmClasses: UvmClassInfo[] } {
    const tree = this.treeSitterParser.parse(text);
    const modules: ModuleNode[] = [];
    const uvmClasses: UvmClassInfo[] = [];

    const walk = (node: any) => {
      // Module declarations
      if (node.type === 'module_declaration' || node.type === 'module_ansi_header') {
        const nameNode = findChild(node, 'module_identifier') ?? findChild(node, 'simple_identifier');
        if (nameNode) {
          const instances = extractTreeSitterInstances(node, filePath);
          modules.push({
            name: nameNode.text,
            filePath,
            line: node.startPosition.row + 1,
            ports: [],
            params: [],
            instances,
          });
        }
      }

      // Class declarations
      if (node.type === 'class_declaration') {
        const nameNode = findChild(node, 'class_identifier') ?? findChild(node, 'simple_identifier');
        const extendsNode = findChild(node, 'class_type');
        if (nameNode && extendsNode) {
          const baseClass = extendsNode.text;
          const uvmType = classifyUvmBase(baseClass);
          uvmClasses.push({
            className: nameNode.text,
            baseClass,
            uvmType,
            filePath,
            line: node.startPosition.row + 1,
            fields: [],
            tlmPorts: [],
            connections: [],
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i));
      }
    };

    walk(tree.rootNode);

    // Always supplement with regex to catch UVM macros and fields
    const regexResult = regexParse(text, filePath);

    // Merge: prefer tree-sitter modules but add regex UVM classes not already found
    const uvmByName = new Map<string, UvmClassInfo>();
    for (const cls of uvmClasses) { uvmByName.set(cls.className, cls); }
    for (const cls of regexResult.uvmClasses) {
      const existing = uvmByName.get(cls.className);
      if (!existing) {
        uvmClasses.push(cls);
        uvmByName.set(cls.className, cls);
      } else {
        // Merge fields, ports, connections from regex into tree-sitter result
        if (existing.fields.length === 0) { existing.fields = cls.fields; }
        if (existing.tlmPorts.length === 0) { existing.tlmPorts = cls.tlmPorts; }
        if (existing.connections.length === 0) { existing.connections = cls.connections; }
      }
    }

    return { modules: modules.length > 0 ? modules : regexResult.modules, uvmClasses };
  }
}

function findChild(node: any, type: string, maxDepth = 3): any | undefined {
  if (maxDepth <= 0) { return undefined; }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) { return child; }
    const deeper = findChild(child, type, maxDepth - 1);
    if (deeper) { return deeper; }
  }
  return undefined;
}

function extractTreeSitterInstances(moduleNode: any, filePath: string): ModuleInstance[] {
  const instances: ModuleInstance[] = [];
  const walk = (node: any) => {
    if (node.type === 'module_instantiation') {
      // First direct simple_identifier child is the module name
      const nameNode = findChild(node, 'simple_identifier', 1);
      // Instance name lives inside hierarchical_instance → name_of_instance
      let instanceName = '';
      const hierInst = findChild(node, 'hierarchical_instance', 1);
      if (hierInst) {
        const nameOfInst = findChild(hierInst, 'name_of_instance', 2);
        if (nameOfInst) {
          const instId = findChild(nameOfInst, 'simple_identifier', 2);
          if (instId) { instanceName = instId.text; }
        }
      }
      if (nameNode) {
        instances.push({
          moduleName: nameNode.text,
          instanceName,
          filePath,
          line: node.startPosition.row + 1,
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  };
  walk(moduleNode);
  return instances;
}

// ─── Hierarchy builders ─────────────────────────────────────────────

function buildModuleHierarchy(allModules: Map<string, ModuleNode>): ModuleNode[] {
  const instantiated = new Set<string>();
  for (const mod of allModules.values()) {
    for (const inst of mod.instances) {
      instantiated.add(inst.moduleName);
    }
  }
  // Root modules are those never instantiated by another
  const roots: ModuleNode[] = [];
  for (const mod of allModules.values()) {
    if (!instantiated.has(mod.name)) {
      roots.push(mod);
    }
  }
  // If no roots found, return all modules (flat)
  return roots.length > 0 ? roots : [...allModules.values()];
}

function buildUvmHierarchy(allClasses: Map<string, UvmClassInfo>): UvmNode[] {
  // Build a map of className → UvmNode
  const nodeMap = new Map<string, UvmNode>();
  for (const cls of allClasses.values()) {
    nodeMap.set(cls.className, {
      className: cls.className,
      baseClass: cls.baseClass,
      uvmType: cls.uvmType,
      filePath: cls.filePath,
      line: cls.line,
      fields: cls.fields,
      children: [],
      tlmPorts: cls.tlmPorts,
      connections: cls.connections,
    });
  }

  // For each class, try to find a parent among known classes and add as child.
  // Containment is determined by fields: if class A has a field of type B, B is a child of A.
  for (const node of nodeMap.values()) {
    for (const field of node.fields) {
      const child = nodeMap.get(field.typeName);
      if (child) {
        node.children.push(child);
      }
    }
  }

  // Roots: nodes that are not children of any other node
  const isChild = new Set<string>();
  for (const node of nodeMap.values()) {
    for (const child of node.children) {
      isChild.add(child.className);
    }
  }

  const roots: UvmNode[] = [];
  for (const node of nodeMap.values()) {
    if (!isChild.has(node.className)) {
      roots.push(node);
    }
  }

  // Sort: tests first, then envs, then the rest
  roots.sort((a, b) => {
    const order: Record<string, number> = { test: 0, env: 1 };
    return (order[a.uvmType] ?? 9) - (order[b.uvmType] ?? 9);
  });

  return roots.length > 0 ? roots : [...nodeMap.values()];
}
