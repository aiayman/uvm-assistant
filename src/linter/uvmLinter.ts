import * as vscode from 'vscode';

export type Severity = 'error' | 'warning' | 'info';

export interface UvmDiagnostic {
  ruleId: string;
  severity: Severity;
  message: string;
  filePath: string;
  line: number;
}

/** Parsed info about a single UVM / SV class for cross-checking */
interface ClassContext {
  className: string;
  baseClass: string;
  baseStripped: string;
  filePath: string;
  startLine: number;
  body: string;
  hasComponentUtils: boolean;
  hasObjectUtils: boolean;
  hasBuildPhase: boolean;
  hasConnectPhase: boolean;
  buildCallsSuper: boolean;
  connectCallsSuper: boolean;
  runCallsSuper: boolean;
  fields: { typeName: string; fieldName: string; line: number }[];
  createCalls: { typeName: string; instanceName: string }[];
  connectCalls: string[];
  tlmPorts: { kind: string; paramType: string; fieldName: string }[];
  newCalls: { varName: string; line: number }[];
  isComponent: boolean;
  isObject: boolean;
  configSets: { paramType: string; path: string; field: string; filePath: string; line: number }[];
  configGets: { paramType: string; path: string; field: string; hasCheck: boolean; line: number }[];
}

// ─── Base class categories ──────────────────────────────────────────

const COMPONENT_BASES = new Set([
  'uvm_component', 'uvm_env', 'uvm_agent', 'uvm_driver', 'uvm_monitor',
  'uvm_scoreboard', 'uvm_test', 'uvm_sequencer', 'uvm_sequencer_base',
  'uvm_subscriber',
]);

const OBJECT_BASES = new Set([
  'uvm_object', 'uvm_sequence_item', 'uvm_sequence', 'uvm_sequence_base',
  'uvm_transaction', 'uvm_reg_sequence',
]);

const HIERARCHICAL_BASES = new Set(['uvm_env', 'uvm_agent', 'uvm_test']);

function stripParams(base: string): string {
  return base.replace(/\s*#\s*\(.*\)/, '').trim();
}

// ─── Line offset index for O(log n) line lookups ────────────────────

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

/** Find the matching `endclass` for a `class` starting at `startIdx`, handling nesting. */
function findMatchingEndclass(text: string, startIdx: number): number {
  let depth = 0;
  const re = /\b(class|endclass)\b/g;
  re.lastIndex = startIdx;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === 'class') {
      depth++;
    } else {
      depth--;
      if (depth === 0) { return m.index + m[0].length; }
    }
  }
  return text.length;
}

// ─── SV keywords to skip during field extraction ────────────────────

const SV_FIELD_KW = new Set([
  'function', 'task', 'virtual', 'static', 'local', 'protected', 'extern',
  'input', 'output', 'inout', 'wire', 'reg', 'logic', 'bit', 'byte',
  'int', 'integer', 'string', 'real', 'void', 'rand', 'randc',
  'constraint', 'covergroup', 'typedef', 'enum', 'struct',
]);

// ─── Parse a class body into ClassContext ────────────────────────────

function parseClassContext(
  className: string,
  baseClass: string,
  body: string,
  filePath: string,
  startLine: number,
): ClassContext {
  const baseStripped = stripParams(baseClass);
  const isComponent = COMPONENT_BASES.has(baseStripped);
  const isObject = OBJECT_BASES.has(baseStripped);

  const hasComponentUtils = /`uvm_component_utils(?:_begin)?\s*\(/.test(body);
  const hasObjectUtils = /`uvm_object_utils(?:_begin)?\s*\(/.test(body);

  // Phase detection
  const buildMatch = body.match(
    /function\s+void\s+build_phase\s*\(\s*uvm_phase\s+\w+\s*\)\s*;([\s\S]*?)endfunction/,
  );
  const connectMatch = body.match(
    /function\s+void\s+connect_phase\s*\(\s*uvm_phase\s+\w+\s*\)\s*;([\s\S]*?)endfunction/,
  );
  const runMatch = body.match(
    /task\s+run_phase\s*\(\s*uvm_phase\s+\w+\s*\)\s*;([\s\S]*?)endtask/,
  );

  const hasBuildPhase = !!buildMatch;
  const hasConnectPhase = !!connectMatch;
  const buildCallsSuper = buildMatch
    ? /super\s*\.\s*build_phase\s*\(/.test(buildMatch[1])
    : false;
  const connectCallsSuper = connectMatch
    ? /super\s*\.\s*connect_phase\s*\(/.test(connectMatch[1])
    : false;
  const runCallsSuper = runMatch
    ? /super\s*\.\s*run_phase\s*\(/.test(runMatch[1])
    : false;

  // Pre-build line index for O(log n) line lookups within the body
  const bodyLineIndex = buildLineIndex(body);

  // Fields
  const fields: ClassContext['fields'] = [];
  const fieldRe = /^\s+(\w+)\s+(\w+)\s*;/gm;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(body)) !== null) {
    if (!SV_FIELD_KW.has(fm[1])) {
      const localLine = lineAtOffset(bodyLineIndex, fm.index);
      fields.push({ typeName: fm[1], fieldName: fm[2], line: startLine + localLine });
    }
  }

  // create() calls in build_phase
  const createCalls: ClassContext['createCalls'] = [];
  if (buildMatch) {
    const cre = /(\w+)\s*=\s*(\w+)\s*::\s*type_id\s*::\s*create\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = cre.exec(buildMatch[1])) !== null) {
      createCalls.push({ typeName: cm[2], instanceName: cm[1] });
    }
  }

  // .connect() calls in connect_phase
  const connectCalls: string[] = [];
  if (connectMatch) {
    const cre = /(\w[\w.]*)\s*\.\s*connect\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = cre.exec(connectMatch[1])) !== null) {
      connectCalls.push(cm[0]);
    }
  }

  // TLM port declarations
  const tlmPorts: ClassContext['tlmPorts'] = [];
  const tlmRe =
    /(uvm_analysis_port|uvm_analysis_export|uvm_analysis_imp|uvm_blocking_put_port|uvm_blocking_get_port)\s*#\s*\(\s*([\w:]+)\s*\)\s+(\w+)/g;
  let tm: RegExpExecArray | null;
  while ((tm = tlmRe.exec(body)) !== null) {
    tlmPorts.push({ kind: tm[1], paramType: tm[2], fieldName: tm[3] });
  }

  // new() calls (UVM types should use create instead)
  const newCalls: ClassContext['newCalls'] = [];
  const newRe = /(\w+)\s*=\s*new\s*\(/g;
  let nm: RegExpExecArray | null;
  while ((nm = newRe.exec(body)) !== null) {
    const localLine = lineAtOffset(bodyLineIndex, nm.index);
    newCalls.push({ varName: nm[1], line: startLine + localLine });
  }

  // config_db set / get
  const configSets: ClassContext['configSets'] = [];
  const configGets: ClassContext['configGets'] = [];
  const setRe =
    /uvm_config_db\s*#\s*\(\s*([\w\s:]+)\s*\)\s*::\s*set\s*\([^,]*,\s*"([^"]*)",\s*"([^"]*)"/g;
  const getRe =
    /(if\s*\(\s*!?\s*)?uvm_config_db\s*#\s*\(\s*([\w\s:]+)\s*\)\s*::\s*get\s*\([^,]*,\s*"([^"]*)",\s*"([^"]*)"/g;
  let sm: RegExpExecArray | null;
  while ((sm = setRe.exec(body)) !== null) {
    const ll = lineAtOffset(bodyLineIndex, sm.index);
    configSets.push({
      paramType: sm[1].trim(),
      path: sm[2],
      field: sm[3],
      filePath,
      line: startLine + ll,
    });
  }
  let gm: RegExpExecArray | null;
  while ((gm = getRe.exec(body)) !== null) {
    const ll = lineAtOffset(bodyLineIndex, gm.index);
    configGets.push({
      paramType: gm[2].trim(),
      path: gm[3],
      field: gm[4],
      hasCheck: !!gm[1],
      line: startLine + ll,
    });
  }

  return {
    className, baseClass, baseStripped, filePath, startLine, body,
    hasComponentUtils, hasObjectUtils,
    hasBuildPhase, hasConnectPhase,
    buildCallsSuper, connectCallsSuper, runCallsSuper,
    fields, createCalls, connectCalls, tlmPorts, newCalls,
    isComponent, isObject, configSets, configGets,
  };
}

// ─── Extract all classes from source text ───────────────────────────

function extractClasses(text: string, filePath: string): ClassContext[] {
  const results: ClassContext[] = [];
  const textLineIndex = buildLineIndex(text);
  const classRe = /^\s*class\s+(\w+)\s+extends\s+([\w#() ,]+?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text)) !== null) {
    const startLine = lineAtOffset(textLineIndex, m.index) + 1;
    const endIdx = findMatchingEndclass(text, m.index);
    const body = text.slice(m.index, endIdx);
    results.push(parseClassContext(m[1], m[2].trim(), body, filePath, startLine));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
//  Rule implementations
// ═══════════════════════════════════════════════════════════════════

// ─── UVM001-004: Registration checks ────────────────────────────────

function checkRegistration(ctx: ClassContext, d: UvmDiagnostic[]): void {
  if (ctx.isComponent && !ctx.hasComponentUtils && !ctx.hasObjectUtils) {
    d.push({
      ruleId: 'UVM001', severity: 'error',
      message: `'${ctx.className}' extends '${ctx.baseStripped}' but is missing \`uvm_component_utils(${ctx.className})\`.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (ctx.isObject && !ctx.hasObjectUtils && !ctx.hasComponentUtils) {
    d.push({
      ruleId: 'UVM002', severity: 'error',
      message: `'${ctx.className}' extends '${ctx.baseStripped}' but is missing \`uvm_object_utils(${ctx.className})\`.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (ctx.isComponent && ctx.hasObjectUtils && !ctx.hasComponentUtils) {
    d.push({
      ruleId: 'UVM003', severity: 'error',
      message: `'${ctx.className}' is a uvm_component but uses \`uvm_object_utils\` — use \`uvm_component_utils\`.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (ctx.isObject && ctx.hasComponentUtils && !ctx.hasObjectUtils) {
    d.push({
      ruleId: 'UVM004', severity: 'error',
      message: `'${ctx.className}' is a uvm_object but uses \`uvm_component_utils\` — use \`uvm_object_utils\`.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
}

// ─── UVM005-009: Phase checks ───────────────────────────────────────

function checkPhases(ctx: ClassContext, d: UvmDiagnostic[]): void {
  if (ctx.hasBuildPhase && !ctx.buildCallsSuper) {
    d.push({
      ruleId: 'UVM005', severity: 'warning',
      message: `'${ctx.className}.build_phase' does not call super.build_phase(phase).`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (ctx.hasConnectPhase && !ctx.connectCallsSuper) {
    d.push({
      ruleId: 'UVM006', severity: 'warning',
      message: `'${ctx.className}.connect_phase' does not call super.connect_phase(phase).`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (HIERARCHICAL_BASES.has(ctx.baseStripped) && !ctx.hasBuildPhase) {
    d.push({
      ruleId: 'UVM007', severity: 'warning',
      message: `'${ctx.className}' extends '${ctx.baseStripped}' but has no build_phase — children won't be created.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (ctx.tlmPorts.length > 0 && !ctx.hasConnectPhase) {
    d.push({
      ruleId: 'UVM008', severity: 'info',
      message: `'${ctx.className}' declares TLM ports (${ctx.tlmPorts.map((p) => p.fieldName).join(', ')}) but has no connect_phase.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (ctx.runCallsSuper) {
    d.push({
      ruleId: 'UVM009', severity: 'info',
      message: `'${ctx.className}.run_phase' calls super.run_phase — this is usually unnecessary.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
}

// ─── UVM010: Connection checks ──────────────────────────────────────

function checkConnections(ctx: ClassContext, d: UvmDiagnostic[]): void {
  for (const port of ctx.tlmPorts) {
    const connected = ctx.connectCalls.some((c) => c.includes(port.fieldName));
    if (!connected && ctx.hasConnectPhase) {
      d.push({
        ruleId: 'UVM010', severity: 'warning',
        message: `TLM port '${port.fieldName}' in '${ctx.className}' is declared but never connected in connect_phase.`,
        filePath: ctx.filePath, line: ctx.startLine,
      });
    }
  }
}

// ─── UVM014, UVM016: Instantiation checks ───────────────────────────

function checkInstantiations(
  ctx: ClassContext,
  all: Map<string, ClassContext>,
  d: UvmDiagnostic[],
): void {
  // UVM014: Component created with new() instead of type_id::create()
  for (const nc of ctx.newCalls) {
    const field = ctx.fields.find((f) => f.fieldName === nc.varName);
    if (field) {
      const target = all.get(field.typeName);
      if (target && (target.isComponent || target.isObject)) {
        d.push({
          ruleId: 'UVM014', severity: 'error',
          message: `'${nc.varName}' is UVM type '${field.typeName}' — use ${field.typeName}::type_id::create() instead of new().`,
          filePath: ctx.filePath, line: nc.line,
        });
      }
    }
  }

  // UVM016: Component field declared but never created in build_phase
  if (ctx.hasBuildPhase && ctx.isComponent) {
    for (const field of ctx.fields) {
      const target = all.get(field.typeName);
      if (target && target.isComponent) {
        const created = ctx.createCalls.some(
          (c) => c.instanceName === field.fieldName || c.typeName === field.typeName,
        );
        if (!created) {
          d.push({
            ruleId: 'UVM016', severity: 'warning',
            message: `Field '${field.fieldName}' (${field.typeName}) is declared but never created in build_phase.`,
            filePath: ctx.filePath, line: field.line,
          });
        }
      }
    }
  }
}

// ─── UVM019: config_db checks ───────────────────────────────────────

function checkConfigDb(ctx: ClassContext, d: UvmDiagnostic[]): void {
  for (const g of ctx.configGets) {
    if (!g.hasCheck) {
      d.push({
        ruleId: 'UVM019', severity: 'warning',
        message: `uvm_config_db#(${g.paramType})::get() for '${g.field}' — wrap in if(!...) with \`uvm_fatal.`,
        filePath: ctx.filePath, line: g.line,
      });
    }
  }
}

// ─── UVM012, UVM022: Agent completeness ─────────────────────────────

function checkAgent(
  ctx: ClassContext,
  all: Map<string, ClassContext>,
  d: UvmDiagnostic[],
): void {
  if (ctx.baseStripped !== 'uvm_agent') { return; }

  const allTypes = new Set([
    ...ctx.fields.map((f) => f.typeName),
    ...ctx.createCalls.map((c) => c.typeName),
  ]);

  let hasDriver = false;
  let hasMonitor = false;
  let hasSequencer = false;

  for (const t of allTypes) {
    const cls = all.get(t);
    if (!cls) { continue; }
    if (cls.baseStripped === 'uvm_driver' || cls.baseClass.startsWith('uvm_driver')) {
      hasDriver = true;
    }
    if (cls.baseStripped === 'uvm_monitor') { hasMonitor = true; }
    if (
      cls.baseStripped === 'uvm_sequencer' ||
      cls.baseStripped === 'uvm_sequencer_base' ||
      cls.baseClass.startsWith('uvm_sequencer')
    ) {
      hasSequencer = true;
    }
  }

  if (hasDriver && !hasSequencer) {
    d.push({
      ruleId: 'UVM022', severity: 'warning',
      message: `Agent '${ctx.className}' has a driver but no sequencer.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
  if (!hasMonitor) {
    d.push({
      ruleId: 'UVM023', severity: 'warning',
      message: `Agent '${ctx.className}' has no monitor.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }

  // UVM012: Driver seq_item_port not connected
  if (hasDriver && ctx.hasConnectPhase) {
    if (!ctx.connectCalls.some((c) => c.includes('seq_item_port'))) {
      d.push({
        ruleId: 'UVM012', severity: 'error',
        message: `Agent '${ctx.className}' has a driver but connect_phase doesn't connect seq_item_port.`,
        filePath: ctx.filePath, line: ctx.startLine,
      });
    }
  } else if (hasDriver && !ctx.hasConnectPhase) {
    d.push({
      ruleId: 'UVM012', severity: 'error',
      message: `Agent '${ctx.className}' has a driver but no connect_phase for seq_item_port.`,
      filePath: ctx.filePath, line: ctx.startLine,
    });
  }
}

// ─── UVM018, UVM020: Cross-file config_db checks ────────────────────

function checkCrossFileConfigDb(
  all: Map<string, ClassContext>,
  d: UvmDiagnostic[],
): void {
  // Key by path + field to avoid collisions between identically-named fields
  // in different config_db scopes.
  const allGets = new Map<string, { paramType: string }>();
  for (const ctx of all.values()) {
    for (const g of ctx.configGets) {
      const key = `${g.path}/${g.field}`;
      allGets.set(key, { paramType: g.paramType });
    }
  }
  for (const ctx of all.values()) {
    for (const s of ctx.configSets) {
      const key = `${s.path}/${s.field}`;
      const getter = allGets.get(key);
      if (!getter) {
        d.push({
          ruleId: 'UVM018', severity: 'info',
          message: `config_db#(${s.paramType})::set for '${s.field}' has no matching ::get in any class.`,
          filePath: s.filePath, line: s.line,
        });
      } else if (getter.paramType !== s.paramType) {
        d.push({
          ruleId: 'UVM020', severity: 'error',
          message: `config_db type mismatch for '${s.field}': set=#(${s.paramType}) but get=#(${getter.paramType}).`,
          filePath: s.filePath, line: s.line,
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Run all UVM lint rules across the given workspace file texts.
 * Returns diagnostics grouped by file path.
 */
export function runUvmLinter(
  fileTexts: Map<string, string>,
): Map<string, UvmDiagnostic[]> {
  // 1. Parse all classes across all files
  const allClasses = new Map<string, ClassContext>();
  for (const [filePath, text] of fileTexts) {
    for (const cls of extractClasses(text, filePath)) {
      allClasses.set(cls.className, cls);
    }
  }

  // 2. Run per-class rules
  const allDiags: UvmDiagnostic[] = [];
  for (const ctx of allClasses.values()) {
    checkRegistration(ctx, allDiags);
    checkPhases(ctx, allDiags);
    checkConnections(ctx, allDiags);
    checkInstantiations(ctx, allClasses, allDiags);
    checkConfigDb(ctx, allDiags);
    checkAgent(ctx, allClasses, allDiags);
  }

  // 3. Run cross-file rules
  checkCrossFileConfigDb(allClasses, allDiags);

  // 4. Group by file
  const byFile = new Map<string, UvmDiagnostic[]>();
  for (const diag of allDiags) {
    const arr = byFile.get(diag.filePath) ?? [];
    arr.push(diag);
    byFile.set(diag.filePath, arr);
  }

  return byFile;
}

/** Convert our severity to a VS Code DiagnosticSeverity */
export function toVscodeSeverity(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'info': return vscode.DiagnosticSeverity.Information;
  }
}
