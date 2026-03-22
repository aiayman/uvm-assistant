import { ModuleNode, ModuleInstance, PortInfo } from '../models/moduleNode';
import { UvmClassInfo, UvmField, TlmPort, TlmConnection, TlmPortKind } from '../models/uvmNode';
import { classifyUvmBase } from '../utils/uvmClassifier';

// ─── Module declarations ────────────────────────────────────────────
const MODULE_DECL_RE =
  /^\s*module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\([^)]*\))?\s*;/gm;

// ─── Module instantiations ──────────────────────────────────────────
// Matches: module_name #(...) inst_name (...);  or  module_name inst_name (...);
const MODULE_INST_RE =
  /^\s*(\w+)\s+(?:#\s*\([^)]*\)\s+)?(\w+)\s*\(/gm;

// Known SV keywords that look like instantiation but aren't
const SV_KEYWORDS = new Set([
  'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
  'assign', 'always', 'initial', 'begin', 'end', 'if', 'else', 'for',
  'while', 'case', 'endcase', 'function', 'endfunction', 'task', 'endtask',
  'class', 'endclass', 'extends', 'implements', 'virtual', 'static',
  'parameter', 'localparam', 'generate', 'endgenerate', 'typedef', 'enum',
  'struct', 'union', 'interface', 'endinterface', 'package', 'endpackage',
  'import', 'export', 'return', 'void', 'bit', 'byte', 'int', 'integer',
  'real', 'string', 'shortint', 'longint', 'time', 'realtime',
  'signed', 'unsigned', 'genvar', 'default', 'packed',
  'constraint', 'covergroup', 'endgroup', 'property', 'endproperty',
  'sequence', 'endsequence', 'assert', 'assume', 'cover',
  'rand', 'randc', 'forever', 'repeat', 'wait', 'fork', 'join',
  'join_any', 'join_none', 'disable', 'force', 'release',
]);

// ─── Port extraction (simplified) ──────────────────────────────────
const PORT_RE = /\b(input|output|inout)\s+(?:\w+\s+)?(?:\[.*?\]\s*)?(\w+)/g;

// ─── UVM class declarations ────────────────────────────────────────
const CLASS_DECL_RE =
  /^\s*class\s+(\w+)\s+extends\s+([\w#() ,]+?)\s*;/gm;

// ─── Field declarations inside class body (heuristic) ──────────────
// Matches: type_name field_name;
const FIELD_RE =
  /^\s+(\w+)\s+(\w+)\s*;/gm;

/**
 * Parse a single SystemVerilog file using regex patterns.
 * Returns extracted modules and UVM classes.
 */
export function regexParse(
  text: string,
  filePath: string,
): { modules: ModuleNode[]; uvmClasses: UvmClassInfo[] } {
  const modules: ModuleNode[] = [];
  const uvmClasses: UvmClassInfo[] = [];
  const lineIndex = buildLineIndex(text);

  // --- Extract module declarations ---
  let match: RegExpExecArray | null;
  MODULE_DECL_RE.lastIndex = 0;
  while ((match = MODULE_DECL_RE.exec(text)) !== null) {
    const moduleName = match[1];
    const line = lineAtOffset(lineIndex, match.index) + 1;

    // Find module body to extract ports and instances
    const endIdx = findEndModule(text, match.index);
    const body = text.slice(match.index, endIdx);

    const ports = extractPorts(body);
    const instances = extractInstances(body, filePath, match.index, lineIndex);

    modules.push({
      name: moduleName,
      filePath,
      line,
      ports,
      params: [],
      instances,
    });
  }

  // --- Extract UVM class declarations ---
  CLASS_DECL_RE.lastIndex = 0;
  while ((match = CLASS_DECL_RE.exec(text)) !== null) {
    const className = match[1];
    const baseClass = match[2].trim();
    const line = lineAtOffset(lineIndex, match.index) + 1;
    const uvmType = classifyUvmBase(baseClass);

    // Extract fields from class body
    const endIdx = findEndClass(text, match.index);
    const body = text.slice(match.index, endIdx);
    const fields = extractFields(body, line);
    const tlmPorts = extractTlmPorts(body);
    const connections = extractConnections(body, line);
    const virtualIfs = extractVirtualInterfaces(body);

    uvmClasses.push({
      className,
      baseClass,
      uvmType,
      filePath,
      line,
      fields,
      tlmPorts,
      connections,
      virtualIfs,
    });
  }

  return { modules, uvmClasses };
}

/** Build a sorted array of character offsets where each line starts. */
function buildLineIndex(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { offsets.push(i + 1); }
  }
  return offsets;
}

/** Binary-search the line index to find the 0-based line number at `offset`. */
function lineAtOffset(lineIndex: number[], offset: number): number {
  let lo = 0;
  let hi = lineIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineIndex[mid] <= offset) { lo = mid + 1; }
    else { hi = mid; }
  }
  return lo - 1;
}

/** Find the matching end-keyword accounting for nesting. */
function findMatchingEnd(text: string, startIdx: number, openKw: string, closeKw: string): number {
  let depth = 0;
  const re = new RegExp(`\\b(${openKw}|${closeKw})\\b`, 'g');
  re.lastIndex = startIdx;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === openKw) {
      depth++;
    } else {
      depth--;
      if (depth === 0) { return m.index + m[0].length; }
    }
  }
  return text.length;
}

function findEndModule(text: string, startIdx: number): number {
  return findMatchingEnd(text, startIdx, 'module', 'endmodule');
}

function findEndClass(text: string, startIdx: number): number {
  return findMatchingEnd(text, startIdx, 'class', 'endclass');
}

function extractPorts(moduleBody: string): PortInfo[] {
  const ports: PortInfo[] = [];
  PORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PORT_RE.exec(moduleBody)) !== null) {
    ports.push({
      name: m[2],
      direction: m[1] as PortInfo['direction'],
    });
  }
  return ports;
}

function extractInstances(
  moduleBody: string,
  filePath: string,
  moduleStartIdx: number,
  fullTextLineIndex: number[],
): ModuleInstance[] {
  const instances: ModuleInstance[] = [];
  MODULE_INST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODULE_INST_RE.exec(moduleBody)) !== null) {
    const moduleName = m[1];
    const instanceName = m[2];
    if (SV_KEYWORDS.has(moduleName)) { continue; }
    const line = lineAtOffset(fullTextLineIndex, moduleStartIdx + m.index) + 1;
    instances.push({ moduleName, instanceName, filePath, line });
  }
  return instances;
}

// ─── TLM port kind mapping ───────────────────────────────────────────
const TLM_KIND_MAP: Record<string, TlmPortKind> = {
  'uvm_analysis_port': 'analysis_port',
  'uvm_analysis_export': 'analysis_export',
  'uvm_analysis_imp': 'analysis_imp',
  'uvm_blocking_put_port': 'blocking_put_port',
  'uvm_blocking_get_port': 'blocking_get_port',
};

function extractTlmPorts(classBody: string): TlmPort[] {
  const ports: TlmPort[] = [];
  const re = /(uvm_analysis_port|uvm_analysis_export|uvm_analysis_imp|uvm_blocking_put_port|uvm_blocking_get_port)\s*#\s*\(\s*([\w:]+)\s*\)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(classBody)) !== null) {
    ports.push({
      kind: TLM_KIND_MAP[m[1]],
      paramType: m[2],
      fieldName: m[3],
    });
  }
  return ports;
}

function extractConnections(classBody: string, classStartLine: number): TlmConnection[] {
  const connections: TlmConnection[] = [];
  // Match: foo.port.connect(bar.export)  or  foo.connect(bar)
  const connectPhaseMatch = classBody.match(
    /function\s+void\s+connect_phase\s*\(\s*uvm_phase\s+\w+\s*\)\s*;([\s\S]*?)endfunction/,
  );
  if (!connectPhaseMatch) { return connections; }
  const bodyOffset = connectPhaseMatch.index!;
  const body = connectPhaseMatch[1];
  const bodyStartOffset = bodyOffset + connectPhaseMatch[0].indexOf(body);
  const bodyLineIndex = buildLineIndex(classBody);
  const re = /([\w.]+)\s*\.\s*connect\s*\(\s*([\w.]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const localLine = lineAtOffset(bodyLineIndex, bodyStartOffset + m.index);
    connections.push({ from: m[1], to: m[2], line: classStartLine + localLine });
  }
  return connections;
}

function extractVirtualInterfaces(classBody: string): string[] {
  // Match: virtual interface_name field;  or  virtual interface interface_name.modport field;
  const re = /virtual\s+(?:interface\s+)?(\w+)(?:\.\w+)?\s+\w+/g;
  const ifs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(classBody)) !== null) {
    const name = m[1];
    // Skip UVM base types and SV keywords
    if (!name.startsWith('uvm_') && !SV_KEYWORDS.has(name)) {
      ifs.push(name);
    }
  }
  return [...new Set(ifs)];
}

function extractFields(classBody: string, classStartLine: number): UvmField[] {
  const fields: UvmField[] = [];
  const bodyLineIndex = buildLineIndex(classBody);
  FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_RE.exec(classBody)) !== null) {
    const typeName = m[1];
    const fieldName = m[2];
    // Skip SV keywords that look like fields
    if (SV_KEYWORDS.has(typeName)) { continue; }
    const localLine = lineAtOffset(bodyLineIndex, m.index);
    fields.push({ typeName, fieldName, line: classStartLine + localLine });
  }
  return fields;
}
