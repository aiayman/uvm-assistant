# UVM-Assistant — Full Project Context for Agent Handoff

**Date**: 2026-04-15  
**Current version**: 1.18.0  
**Repo**: `github.com:aiayman/uvm-assistant.git` (branch: `main`)  
**Working dir**: `/home/ayman/siework/uvm-assistant`

---

## 1. What This Is

A VS Code extension that analyzes SystemVerilog/UVM testbench workspaces and produces:

1. **Module Hierarchy** tree view (Verilog module instantiation graph)
2. **UVM Class Hierarchy** tree view (UVM component containment tree)
3. **Block Diagram** webview (simple nested rectangles of UVM hierarchy)
4. **Data Flow Diagram** webview (pipeline-stage placement with A* orthogonal routing, interactive, zoomable)
5. **UVM Linter** (15+ rules: UVM001-UVM023)
6. **Verible Formatter** integration (SystemVerilog formatting)
7. **Mapping Table** (togglable panel showing detected components/connections with user override capability)

---

## 2. File Structure & Line Counts

```
src/
├── extension.ts               (155 lines) — Entry point, command registration, analysis orchestration
├── fileScanner.ts             (175 lines) — Workspace file scanning with .gitignore support
├── overrideManager.ts          (60 lines) — Load/save .uvm-assistant.json overrides
├── formatter/
│   └── veribleFormatter.ts              — Verible integration
├── linter/
│   └── uvmLinter.ts           (556 lines) — UVM lint rules
├── models/
│   ├── moduleNode.ts                    — ModuleNode, PortInfo interfaces
│   ├── uvmNode.ts              (89 lines) — UvmNode, UvmClassInfo, DutInfo, TlmPort, TestbenchProject
│   └── overrides.ts            (53 lines) — OverrideConfig, MappingComponent, MappingConnection interfaces
├── parser/
│   ├── svParser.ts            (436 lines) — Main parser: tree-sitter + regex fallback, DUT detection, hierarchy builder
│   ├── regexFallback.ts       (261 lines) — Regex-based SV parsing (modules, instances, UVM classes, TLM, etc.)
│   └── treeSitterInit.ts               — Tree-sitter WASM grammar loader
├── utils/
│   └── uvmClassifier.ts                — Maps base classes to UvmType
└── views/
    ├── moduleHierarchyProvider.ts       — TreeDataProvider for module hierarchy
    ├── uvmClassProvider.ts              — TreeDataProvider for UVM class hierarchy
    └── uvmDiagramPanel.ts     (205 lines) — WebviewPanel host: HTML shell, message passing, override save

webview/
├── diagram.ts                (1777 lines) — Data Flow Diagram: placement, A* routing, drawing, mapping table
├── diagram.css                (480 lines) — Data Flow Diagram styles + mapping panel styles
├── blockDiagram.ts            (273 lines) — Block Diagram: simple hierarchy rectangles
└── blockDiagram.css                     — Block Diagram styles

Total: ~4250 lines of application code
```

---

## 3. Architecture & Data Flow

### Parse Pipeline
```
fileScanner.scanWorkspace()
  → svParser.parseWorkspace(files)
    → treeSitterInit (optional, falls back to regex)
    → regexFallback.ts extracts: modules, instances, UVM classes, TLM ports, connections, virtual interfaces
    → svParser builds: module hierarchy, UVM class hierarchy (field containment + transitive type resolution)
    → svParser.detectDuts(): finds run_test() → testbench top modules → their instances = DUTs
    → svParser.detectProjects(): groups by directory structure for multi-project workspaces
  → ParseResult { moduleRoots, allModules, uvmRoots, duts, projects, fileTexts }
```

### Diagram Pipeline
```
extension.ts buildProjectList(result) → SerializedProject[]
extension.ts loadOverrides() → OverrideConfig from .uvm-assistant.json
  → UvmDiagramPanel.createOrShow(extensionUri, projects, 'dataflow', overrides)
    → panel.webview.postMessage({ command: 'renderDiagram', projects, overrides })
      → webview/diagram.ts receives message
        → refreshWithOverrides()
          → getEffectiveData(proj, overrides) — clones UVM tree with removals/reclassifications, merges DUT additions
          → renderProject(roots, duts, connOverrides)
            → PHASE 1: PLACEMENT — pipeline-stage column layout, agent grouping, container nesting
            → PHASE 2: ROUTING — grid A* pathfinding with occupancy grid, stub-based routing
            → PHASE 3: DRAWING — SVG elements, port dots, arrow paths, labels, junctions
          → renderMappingPanel() — HTML tables for component/connection editing
```

### Override/Mapping Flow
```
User edits in mapping table (role dropdown, remove button, add dialog)
  → saveAndRefresh()
    → vscode.postMessage({ command: 'saveOverrides', overrides })
    → panel receives → overrideManager.saveOverrides() writes to .uvm-assistant.json
    → panel echoes back → webview re-applies overrides → diagram re-renders
```

---

## 4. Key Data Structures

### UvmNode (src/models/uvmNode.ts)
```typescript
interface UvmNode {
  className: string;      // e.g. "axi_driver"
  baseClass: string;      // e.g. "uvm_driver"
  uvmType: UvmType;       // 'test' | 'env' | 'agent' | 'driver' | 'monitor' | 'sequencer' | 'scoreboard' | ...
  filePath: string;
  line: number;
  fields: UvmField[];     // { typeName, fieldName, line }
  children: UvmNode[];    // Containment hierarchy
  tlmPorts: TlmPort[];    // { kind: TlmPortKind, paramType, fieldName }
  connections: TlmConnection[]; // { from: "drv.seq_item_port", to: "seqr.seq_item_export", line }
  virtualIfs: string[];   // Virtual interface type names
}

interface DutInfo {
  moduleName: string;     // e.g. "axi_ram"
  instanceName: string;   // e.g. "dut"
  filePath: string;
  line: number;
}

interface TestbenchProject {
  name: string;           // Directory-derived name
  rootDir: string;
  uvmRoots: UvmNode[];
  duts: DutInfo[];
}
```

### OverrideConfig (src/models/overrides.ts)
```typescript
interface OverrideConfig {
  addedComponents?: ComponentOverride[];     // { name, role, filePath, line, instanceName }
  removedComponents?: string[];              // Names to hide
  roleOverrides?: Record<string, string>;    // className → newRole
  addedConnections?: ConnectionOverride[];   // { from, to, label }
  removedConnections?: ConnectionOverride[]; // { from, to } to hide
}
```

### Diagram Internal Types (webview/diagram.ts)
```typescript
interface BlockRect { x, y, w, h: number; node: UvmDiagramNode; kind: 'uvm' | 'dut'; stage: number; }
interface Arrow { from: BlockRect; to: BlockRect; label, color, marker: string; dashed: boolean; filePath?, line?: ... }
interface OccGrid { data: Uint8Array; cols: number; rows: number; }
```

### Pipeline Stage Assignment
```typescript
const STAGE: Record<string, number> = {
  sequence: 0, sequencer: 1, driver: 2, dut: 3, monitor: 4, scoreboard: 5,
  agent: -1, env: -1, test: -1,  // containers (stage < 0)
};
```

---

## 5. Routing Engine (webview/diagram.ts ~lines 800-1080)

**Grid-based A* orthogonal router** (replaced channel-based router in v1.15.0):

- **GRID=10px** cells, **ROUTE_MARGIN=1** cell clearance
- **Occupancy grid**: `Uint8Array` row-major, marks solid blocks (stage≥0) as impassable with margin, marks container borders (agents, envs) as obstacles but leaves interiors free
- **Direction-aware states**: `(col, row, dir)` where dir ∈ {0=→, 1=↓, 2=←, 3=↑}
- **Turn penalty=3** to prefer straight paths
- **STUB_LEN=16px** stubs at both ends guarantee rightward first/last segments (arrowheads face right)
- **Corridor clearing**: Before each route, temporarily unblocks source/target blocks + cuts horizontal corridors through container borders at port heights
- **Path marking**: After routing, marks 3-cell-wide corridor on the grid to prevent overlap
- **Perimeter fallback**: If A* fails, routes above all blocks

---

## 6. DUT Detection (src/parser/svParser.ts `detectDuts()`)

1. Find files containing `run_test()` → testbench top files
2. Find modules defined in those files → testbench top modules
3. For each top module, extract its instances → DUT candidates
4. Filter: only instances where the module name exists in `allModules` (avoids classifying interfaces as DUTs)
5. **Companion top fallback**: If a tb_top module has no instances (e.g. split `top.sv` / `testbench.sv` pattern), search other top-level modules that are NOT in tb_top files for their instances

**Known projects that exercise this**:
- `emu-axi-uvm-main`: Split top/testbench pattern, DUT is `axi_ram` in `hdl/top.sv`
- `UVM_TestBench_For_Single_Port_RAM`: Single `testbench.sv` with DUT `RAM` from `design.sv`

Test projects live at: `/home/ayman/siework/uvm-assistant_tests/`

---

## 7. Connection Inference (webview/diagram.ts `drawAllConnections()`)

Four connection sources, in order:
1. **Explicit TLM** — from `connect_phase` parsing (`node.connections[]`)
2. **Inferred driver↔sequencer** — within each agent, if both driver and sequencer exist
3. **Driver→DUT, DUT→Monitor** — via virtual interface names
4. **Monitor/Agent→Scoreboard** — via analysis_port detection (fallback if no explicit TLM)

Connection overrides (from `.uvm-assistant.json`) are applied as step 5:
- Remove connections matching `{from, to}` pairs
- Add user-defined connections by looking up drawn blocks by className

---

## 8. Recent Commit History

```
v1.18.0  (pending)  feat: reg-model + derived classes + smarter DUT + dblclick-nav
v1.17.0  810a2fc  feat: respect .gitignore when scanning workspace files
v1.16.0  f76bd9c  Smart DUT detection + mapping table with user overrides
v1.15.3  3f6e838  Labels glow with hovered connection
v1.15.2  3996f06  fix: connections avoid container borders, arrowheads face right, labels don't overlap
v1.15.1  4bb938d  fix: prevent connections from striking through solid blocks
v1.15.0  2999b64  feat: grid-based A* router replacing channel-based routing
```

### v1.18.0 — What Changed

- **Block-diagram navigation** now uses double-click (was single-click). The data-flow diagram was already dblclick.
- **UVM register model** classes recognized: `uvm_reg_block`, `uvm_reg`, `uvm_reg_sequence`, `uvm_reg_adapter`, `uvm_reg_predictor`, `uvm_subscriber`, `uvm_push_driver`, `uvm_push_sequencer`, `uvm_transaction`, `uvm_sequence_item`. New stages, themes, icons, and role-dropdown entries added in [webview/diagram.ts](webview/diagram.ts). `reg_block` is treated as a container (recursed into like env/agent).
- **Derived-class classification** now runs globally across the workspace before per-project hierarchy build via `resolveUvmTypesTransitively()` in [src/parser/svParser.ts](src/parser/svParser.ts) — fixes cases where a user base class lives in a shared dir and subclasses live in project dirs.
- **CLASS_DECL_RE** and **MODULE_INST_RE** in [src/parser/regexFallback.ts](src/parser/regexFallback.ts) now handle parameterized declarations (`class foo #(type T) extends bar #(T);`) and instantiations with nested parens (`Module #(.P(mode)) inst (...)`) — critical for SPI-style testbenches.
- **Smart DUT detection** in `detectDuts()` now scores candidates by:
  - +100 if the instance ports bind to an interface published via `uvm_config_db#(virtual ...)::set(...)`
  - +50 if bound to any interface instance declared in tb_top
  - +30 for DUT-like instance names (`dut`, `u_dut`, `m_dut`, etc.)
  - +20 if module body has RTL constructs (`always`, `assign`, `generate`)
  - -100 for utility names (clk_gen, checker, assertion, etc.)
  Falls back to legacy behavior if all candidates score ≤ 0.

---

## 9. Build & Release Process

```bash
# Build
npm run compile                         # esbuild → dist/

# Package VSIX (requires Node 20+)
export PATH="$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"
npx vsce package --no-dependencies      # → uvm-assistant-X.Y.Z.vsix

# Install
code --install-extension uvm-assistant-X.Y.Z.vsix --force

# Release
git add <files> && git commit -m "v1.X.Y: ..."
git push && git tag v1.X.Y && git push origin v1.X.Y
```

**Standing instructions**: Always bump version before pushing. Never reuse a tagged version. Always commit, push, and tag after building VSIX.

---

## 10. Known Issues & Technical Debt

1. **Unused constants** in diagram.ts: `TRACK_SPACING`, `BLOCK_ARROW_GAP`, `PERIMETER_MARGIN` — leftovers from old channel-based router
2. **No test suite** — zero test coverage
3. **Tree-sitter grammar** — optional, falls back to regex; may not be present in all environments
4. **Mapping table** dialogs are basic HTML — no input validation or autocomplete for file paths
5. **Connection override matching** uses className only — if two components share a name across projects, overrides may collide

---

## 11. Color Scheme

| Role        | Fill      | Stroke    | Connection Color |
|-------------|-----------|-----------|------------------|
| test        | #1a3a2a   | #4ec9b0   |                  |
| env         | #1a2a3a   | #569cd6   |                  |
| agent       | #1a2a1a   | #6a9955   |                  |
| driver      | #2a2010   | #ce9178   |                  |
| monitor     | #2a2a10   | #dcdcaa   |                  |
| sequencer   | #2a1a2a   | #c586c0   |                  |
| scoreboard  | #2a1515   | #d16969   |                  |
| sequence    | #152a2a   | #b5cea8   |                  |
| dut         | #1a1a2e   | #e6b422   | #e6b422 (dashed) |
| TLM connect |           |           | #8888cc          |
| analysis_port|          |           | #d16969          |
| seq_item    |           |           | #c586c0          |

---

## 12. User Preferences (from memory)

- Always bump version before pushing releases
- Always commit, push, and tag releases automatically after building VSIX
- Mapping table: togglable bottom panel, Level C editing (full add/remove/reclassify), persisted to `.uvm-assistant.json`
- Connections must never penetrate solid blocks (only tests/envs/agents are permeable containers)
- All arrowheads must point left-to-right
- Labels must not overlap with blocks, containers, or other labels
- Labels glow with hovered connection (SVG group hover)
