import * as vscode from 'vscode';
import { ModuleNode, ModuleInstance } from '../models/moduleNode';
import { UvmClassInfo, UvmNode, DutInfo, TestbenchProject } from '../models/uvmNode';
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
  /** DUT modules detected from testbench top instantiations */
  duts: DutInfo[];
  /** Detected testbench projects (grouped by directory) */
  projects: TestbenchProject[];
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

    // Resolve user-derived class types globally BEFORE per-project hierarchies
    // so that a base class in a shared dir still propagates its type to a
    // subclass in another dir. E.g. `class my_mon extends uvm_monitor` in lib/
    // lets `class axi_mon extends my_mon` in proj/ classify as 'monitor'.
    resolveUvmTypesTransitively(allUvmClasses);

    const moduleRoots = buildModuleHierarchy(allModules);
    const uvmRoots = buildUvmHierarchy(allUvmClasses);
    const duts = detectDuts(allModules, fileTexts);
    const projects = detectProjects(files, allUvmClasses, allModules, fileTexts);

    return { moduleRoots, allModules, uvmRoots, allUvmClasses, fileTexts, duts, projects };
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
            virtualIfs: [],
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
        if (existing.virtualIfs.length === 0) { existing.virtualIfs = cls.virtualIfs; }
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
      virtualIfs: cls.virtualIfs,
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

  // ── Transitive type resolution ──
  // If class A extends class B (via baseClass), and B is known, propagate the type to A.
  // Repeat until no more changes (handles chains like test1 → ram_test → uvm_test).
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodeMap.values()) {
      if (node.uvmType !== 'unknown') continue;
      // Strip parameterization from base class to get the raw class name
      const rawBase = node.baseClass.replace(/\s*#\s*\(.*\)/, '').trim();
      const parent = nodeMap.get(rawBase);
      if (parent && parent.uvmType !== 'unknown') {
        node.uvmType = parent.uvmType;
        changed = true;
      }
    }
  }

  // Sort: tests first, then envs, then the rest
  roots.sort((a, b) => {
    const order: Record<string, number> = { test: 0, env: 1 };
    return (order[a.uvmType] ?? 9) - (order[b.uvmType] ?? 9);
  });

  return roots.length > 0 ? roots : [...nodeMap.values()];
}

/**
 * Propagate `uvmType` along the inheritance chain so that user-derived
 * classes inherit the semantic role of their ancestor. Runs until no more
 * changes occur, handling arbitrarily deep chains like:
 *   axi_monitor → my_mon_base → uvm_monitor
 *
 * Works across project boundaries because it operates on the flat map
 * of all classes found in the workspace.
 */
function resolveUvmTypesTransitively(allClasses: Map<string, UvmClassInfo>): void {
  let changed = true;
  let iterations = 0;
  while (changed && iterations++ < 32) {
    changed = false;
    for (const cls of allClasses.values()) {
      if (cls.uvmType !== 'unknown') continue;
      const rawBase = cls.baseClass.replace(/\s*#\s*\(.*\)/, '').trim();
      // Base may be scoped like `my_pkg::my_mon_base` — also try the unqualified name.
      const parent = allClasses.get(rawBase) ?? allClasses.get(rawBase.split('::').pop() ?? rawBase);
      if (parent && parent.uvmType !== 'unknown') {
        cls.uvmType = parent.uvmType;
        changed = true;
      }
    }
  }
}

// ─── Smart DUT detection ────────────────────────────────────────────

interface DutCandidate {
  name: string;
  instanceName: string;
  filePath: string;
  line: number;
  score: number;
  reasons: string[];
}

/** Utility / non-DUT module naming patterns. */
const UTILITY_NAME_RE = /\b(clk_gen|clock_gen|rst_gen|reset_gen|tb_gen|gen_clk|gen_rst|assertion|assertions|checker|sva_|bind_|tb_helper|stim_gen)\b/i;

/** Typical instance names for DUTs. */
const DUT_INSTANCE_RE = /(^|_)dut($|_)|^u_dut$|^i_dut$|^m_dut$|^s_dut$/i;

/**
 * Detect DUT modules. The testbench is identified by finding files containing
 * `run_test(...)`; each module in such a file is a tb_top candidate. For each
 * tb_top, this routine ranks candidate DUTs using several signals:
 *
 *   +100  instance binds at least one port to a virtual-interface instance
 *         (interfaces published via `uvm_config_db#(virtual ...)::set(...)`)
 *   +50   instance binds ports to any interface instance declared in tb_top
 *   +30   instance name matches `dut`/`*_dut`/`u_dut` convention
 *   +20   module body contains RTL constructs (always/assign/generate)
 *   +min(10,N) number of ports (more ports → more likely RTL)
 *   -100  name matches a utility/assertion pattern (clk_gen, checker, etc.)
 *   -40   module has no ports at all
 *
 * If no candidate scores strongly, falls back to the legacy behavior of
 * returning all directly-instantiated modules (minus tb_tops).
 */
function detectDuts(allModules: Map<string, ModuleNode>, fileTexts: Map<string, string>): DutInfo[] {
  // 1. Identify tb_top files / modules
  const tbTopFiles = new Set<string>();
  for (const [filePath, text] of fileTexts) {
    if (/\brun_test\s*\(/.test(text)) tbTopFiles.add(filePath);
  }
  if (tbTopFiles.size === 0) return [];

  const tbTopModules = new Set<string>();
  for (const mod of allModules.values()) {
    if (tbTopFiles.has(mod.filePath)) tbTopModules.add(mod.name);
  }

  // 2. Collect candidate-providing tops:
  //    - primary: tb_top modules themselves
  //    - companion: top-level modules in tb_top files OR in files that share a
  //      directory with a tb_top file (handles split top.sv / testbench.sv).
  const instantiated = new Set<string>();
  for (const mod of allModules.values()) {
    for (const inst of mod.instances) instantiated.add(inst.moduleName);
  }

  const tbDirs = new Set<string>();
  for (const fp of tbTopFiles) {
    const slash = fp.lastIndexOf('/');
    if (slash >= 0) tbDirs.add(fp.slice(0, slash));
  }
  const siblingDirs = new Set<string>();
  for (const d of tbDirs) {
    const slash = d.lastIndexOf('/');
    if (slash >= 0) siblingDirs.add(d.slice(0, slash));
  }

  const companionModules = new Set<string>();
  for (const mod of allModules.values()) {
    if (tbTopModules.has(mod.name)) continue;
    if (instantiated.has(mod.name)) continue;
    const modDir = mod.filePath.slice(0, mod.filePath.lastIndexOf('/'));
    const inTbDir = tbDirs.has(modDir) || tbTopFiles.has(mod.filePath);
    const inSiblingTree = [...siblingDirs].some(sd => modDir.startsWith(sd));
    if (inTbDir || inSiblingTree) companionModules.add(mod.name);
  }

  const hostModules = [
    ...[...tbTopModules].map(n => allModules.get(n)!).filter(Boolean),
    ...[...companionModules].map(n => allModules.get(n)!).filter(Boolean),
  ];

  // 3. Score each distinct instantiated module.
  const byName = new Map<string, DutCandidate>();
  for (const host of hostModules) {
    const hostText = fileTexts.get(host.filePath) ?? '';
    const vifInstances = findVifPublishedInstances(hostText);
    const allInterfaceInstances = findInterfaceInstanceNames(hostText);

    for (const inst of host.instances) {
      if (tbTopModules.has(inst.moduleName)) continue;
      if (!allModules.has(inst.moduleName)) continue;
      const mod = allModules.get(inst.moduleName)!;
      if (tbTopFiles.has(mod.filePath)) continue; // skip modules defined in tb_top file

      const existing = byName.get(inst.moduleName);
      const portBody = extractInstancePortBody(hostText, inst);
      const bindsToVif = vifInstances.size > 0 &&
        [...vifInstances].some(v => new RegExp(`\\b${escapeRegex(v)}\\s*\\.`).test(portBody));
      const bindsToIface = !bindsToVif && allInterfaceInstances.size > 0 &&
        [...allInterfaceInstances].some(v => new RegExp(`\\b${escapeRegex(v)}\\s*\\.`).test(portBody));

      let score = 0;
      const reasons: string[] = [];
      if (bindsToVif)   { score += 100; reasons.push('binds to virtual-interface-published instance'); }
      if (bindsToIface) { score += 50;  reasons.push('binds to interface instance in tb_top'); }
      if (DUT_INSTANCE_RE.test(inst.instanceName)) { score += 30; reasons.push(`instance named "${inst.instanceName}"`); }
      if (hasRtlConstructs(fileTexts.get(mod.filePath) ?? '', mod.name)) { score += 20; reasons.push('module body has RTL constructs'); }
      score += Math.min(10, mod.ports.length);
      if (mod.ports.length === 0) { score -= 40; reasons.push('no ports'); }
      if (UTILITY_NAME_RE.test(mod.name)) { score -= 100; reasons.push('utility/checker name'); }

      if (!existing || score > existing.score) {
        byName.set(inst.moduleName, {
          name: inst.moduleName,
          instanceName: inst.instanceName,
          filePath: mod.filePath,
          line: mod.line,
          score,
          reasons,
        });
      }
    }
  }

  const candidates = [...byName.values()].sort((a, b) => b.score - a.score);

  // 4. Select winners:
  //    - If any candidate scores ≥ 50 (strong signal), return only those.
  //    - Otherwise return every positively-scored candidate.
  //    - If still empty, fall back to the old behavior so we never come up empty
  //      on oddly-structured testbenches.
  const strong = candidates.filter(c => c.score >= 50);
  const picked = strong.length > 0 ? strong : candidates.filter(c => c.score > 0);

  if (picked.length > 0) {
    return picked.map(({ name, instanceName, filePath, line }) => ({
      moduleName: name, instanceName, filePath, line,
    }));
  }

  // Fallback: all direct instances of tb_tops (+ companion tops), deduped.
  const fallback: DutInfo[] = [];
  const seen = new Set<string>();
  for (const host of hostModules) {
    for (const inst of host.instances) {
      if (seen.has(inst.moduleName)) continue;
      if (tbTopModules.has(inst.moduleName)) continue;
      if (!allModules.has(inst.moduleName)) continue;
      const mod = allModules.get(inst.moduleName)!;
      if (tbTopFiles.has(mod.filePath)) continue;
      seen.add(inst.moduleName);
      fallback.push({ moduleName: inst.moduleName, instanceName: inst.instanceName, filePath: mod.filePath, line: mod.line });
    }
  }
  return fallback;
}

/** Extract instance names published via `uvm_config_db#(virtual <type>)::set(ctx, path, name, <inst>)`. */
function findVifPublishedInstances(text: string): Set<string> {
  const result = new Set<string>();
  const re = /uvm_config_db\s*#\s*\(\s*virtual\s+[\w:.]+(?:\s*\.\s*\w+)?\s*\)\s*::\s*set\s*\(([^;]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Split args at top-level commas. Only the last one is the instance name.
    const args = splitTopLevelArgs(m[1]);
    if (args.length >= 2) {
      const last = args[args.length - 1].trim();
      const id = last.match(/^(\w+)$/);
      if (id) result.add(id[1]);
    }
  }
  return result;
}

/** Detect interface instance names by matching `<type> <name>(...);` where <type> ends in `interface`
 *  or is a SV keyword-free identifier used in a `virtual <type>` uvm_config_db elsewhere. Heuristic but cheap. */
function findInterfaceInstanceNames(text: string): Set<string> {
  const result = new Set<string>();
  // Any line that looks like `foo_if name(...)` or `foo_interface name(...)` where type looks like an interface.
  const re = /^\s*(\w*(?:if|interface|intf))\s+(?:#\s*\((?:[^()]|\([^()]*\))*\)\s*)?(\w+)\s*\(/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].toLowerCase() === 'interface') continue;
    result.add(m[2]);
  }
  return result;
}

function extractInstancePortBody(hostText: string, inst: ModuleInstance): string {
  // Find the port-list body of this instance. Use the line as a starting offset.
  const lines = hostText.split('\n');
  if (inst.line < 1 || inst.line > lines.length) return '';
  // Build offset of this line
  let offset = 0;
  for (let i = 0; i < inst.line - 1; i++) offset += lines[i].length + 1;
  // Search forward for first '(' after module name
  const openIdx = hostText.indexOf('(', offset);
  if (openIdx < 0) return '';
  // Walk paren depth to find the matching ')'
  let depth = 0;
  for (let i = openIdx; i < hostText.length; i++) {
    const c = hostText[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return hostText.slice(openIdx + 1, i); }
  }
  return hostText.slice(openIdx + 1);
}

function hasRtlConstructs(text: string, moduleName: string): boolean {
  // Find the module body and look for RTL constructs
  const declRe = new RegExp(`\\bmodule\\s+${escapeRegex(moduleName)}\\b`);
  const m = declRe.exec(text);
  if (!m) return false;
  const endIdx = text.indexOf('endmodule', m.index);
  const body = endIdx > 0 ? text.slice(m.index, endIdx) : text.slice(m.index);
  return /\balways(?:_ff|_comb|_latch)?\b|\bassign\s+\w+\s*=|\bgenerate\b/.test(body);
}

function splitTopLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect separate testbench projects by grouping files by directory structure.
 * Each project directory that contains UVM classes gets its own hierarchy.
 */
function detectProjects(
  files: vscode.Uri[],
  allClasses: Map<string, UvmClassInfo>,
  allModules: Map<string, ModuleNode>,
  fileTexts: Map<string, string>,
): TestbenchProject[] {
  if (files.length === 0) return [];

  // Find common path prefix of all files
  const paths = files.map(f => f.fsPath);
  const commonPrefix = findCommonPathPrefix(paths);

  // Group files by first directory component after the common prefix
  const dirGroups = new Map<string, Set<string>>();
  for (const p of paths) {
    const relative = p.slice(commonPrefix.length);
    const parts = relative.split('/').filter(s => s.length > 0);
    const groupKey = parts.length > 1 ? parts[0] : '__root__';
    const set = dirGroups.get(groupKey) || new Set();
    set.add(p);
    dirGroups.set(groupKey, set);
  }

  // If only one group, return a single project with the full hierarchy
  if (dirGroups.size <= 1) return [];

  // Build a separate project for each directory group
  const projects: TestbenchProject[] = [];
  for (const [dirName, filePaths] of dirGroups) {
    // Filter classes belonging to this group
    const groupClasses = new Map<string, UvmClassInfo>();
    for (const [name, cls] of allClasses) {
      if (filePaths.has(cls.filePath)) {
        groupClasses.set(name, cls);
      }
    }
    if (groupClasses.size === 0) continue;

    const uvmRoots = buildUvmHierarchy(groupClasses);
    const groupDuts = detectDuts(
      new Map([...allModules].filter(([, m]) => filePaths.has(m.filePath))),
      new Map([...fileTexts].filter(([fp]) => filePaths.has(fp))),
    );

    const name = dirName === '__root__' ? 'Default' : dirName.replace(/[_-]/g, ' ');
    const rootDir = dirName === '__root__' ? commonPrefix : commonPrefix + dirName;

    projects.push({ name, rootDir, uvmRoots, duts: groupDuts });
  }

  // Only return multiple projects if there actually are multiple
  return projects.length > 1 ? projects : [];
}

function findCommonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) {
    const last = paths[0].lastIndexOf('/');
    return last >= 0 ? paths[0].slice(0, last + 1) : '';
  }
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    while (!paths[i].startsWith(prefix)) {
      const slash = prefix.lastIndexOf('/', prefix.length - 2);
      if (slash < 0) return '';
      prefix = prefix.slice(0, slash + 1);
    }
  }
  // Ensure prefix ends at a directory boundary
  if (!prefix.endsWith('/')) {
    const slash = prefix.lastIndexOf('/');
    prefix = slash >= 0 ? prefix.slice(0, slash + 1) : '';
  }
  return prefix;
}
