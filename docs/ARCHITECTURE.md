# Architecture

Internals of the UVM-Assistant extension: how a workspace becomes a hierarchy, a diagram, and a set of diagnostics.

For the build/release workflow and open issues, see [DEVELOPMENT.md](DEVELOPMENT.md).

---

## 1. What the extension produces

| Surface | Implementation |
|---|---|
| Module Hierarchy tree | `src/views/moduleHierarchyProvider.ts` |
| UVM Class Hierarchy tree | `src/views/uvmClassProvider.ts` |
| Block Diagram (nested rectangles) | `webview/blockDiagram.ts` |
| Data Flow Diagram (pipeline + A* routing) | `webview/diagram.ts` |
| UVM Linter (18 rules) | `src/linter/uvmLinter.ts` |
| Verible formatter integration | `src/formatter/veribleFormatter.ts` |
| Mapping table + overrides | `webview/diagram.ts` + `src/overrideManager.ts` |

---

## 2. File map

```
src/
├── extension.ts              — Entry point, command registration, analysis orchestration
├── fileScanner.ts            — Workspace file scanning, .gitignore filtering, file watching
├── overrideManager.ts        — Load/save .uvm-assistant.json
├── formatter/
│   └── veribleFormatter.ts   — Document & range formatting via Verible
├── linter/
│   └── uvmLinter.ts          — UVM lint rules (UVM001–UVM023)
├── models/
│   ├── moduleNode.ts         — ModuleNode, PortInfo, ModuleInstance
│   ├── uvmNode.ts            — UvmNode, UvmClassInfo, DutInfo, TlmPort, TestbenchProject
│   └── overrides.ts          — OverrideConfig, MappingComponent, MappingConnection
├── parser/
│   ├── svParser.ts           — Orchestration: tree-sitter + regex, DUT detection, hierarchy builders
│   ├── regexFallback.ts      — Regex SV parsing (modules, instances, classes, TLM, connections)
│   └── treeSitterInit.ts     — Tree-sitter WASM grammar loader
├── utils/
│   └── uvmClassifier.ts      — Base class → UvmType mapping, type → icon mapping
└── views/
    ├── moduleHierarchyProvider.ts
    ├── uvmClassProvider.ts
    └── uvmDiagramPanel.ts    — Webview host: HTML shell, CSP nonce, message passing

webview/
├── diagram.ts                — Data Flow Diagram: placement, A* routing, drawing, mapping table
├── diagram.css               — Data Flow Diagram + mapping panel styles
├── blockDiagram.ts           — Block Diagram: nested containment rectangles
└── blockDiagram.css
```

Roughly 5,300 lines of application code, the bulk of it in `webview/diagram.ts`.

---

## 3. Data flow

### Parse pipeline

```
fileScanner.scanWorkspace()          — findFiles('**/*.{sv,v,svh,vh}') then .gitignore post-filter
  → svParser.parseWorkspace(files)
      → treeSitterInit (optional; undefined ⇒ regex-only)
      → per file: parseWithTreeSitter() or regexParse()
           regexFallback extracts modules, instances, ports,
           UVM classes, fields, TLM ports, connect_phase connections, virtual interfaces
      → resolveUvmTypesTransitively(allUvmClasses)   ← global, before per-project builds
      → buildModuleHierarchy()   — roots = modules never instantiated elsewhere
      → buildUvmHierarchy()      — containment via field types; roots = never a child
      → detectDuts()             — scored candidates from testbench tops
      → detectProjects()         — directory-based grouping for multi-project workspaces
  → ParseResult { moduleRoots, allModules, uvmRoots, allUvmClasses, fileTexts, duts, projects }
```

`fileTexts` is carried through so the linter never re-reads from disk.

Analysis is triggered on activation, by the Refresh command, and by the file watcher —
debounced 500 ms in `extension.ts` so a burst of saves runs one analysis, not many.

### Diagram pipeline

```
extension.ts buildProjectList(result) → SerializedProject[]
extension.ts loadOverrides()          → OverrideConfig from .uvm-assistant.json
  → UvmDiagramPanel.createOrShow(extensionUri, projects, 'dataflow', overrides)
      → postMessage { command: 'renderDiagram', projects, overrides }
          → webview/diagram.ts refreshWithOverrides()
              → getEffectiveData(proj, overrides)   — clone tree, drop removals,
                                                      apply role overrides, merge added DUTs
              → renderProject(roots, duts, connOverrides)
                   PHASE 1  PLACEMENT — stage columns, agent grouping, container nesting
                   PHASE 2  ROUTING   — grid A* with occupancy grid and stubs
                   PHASE 3  DRAWING   — SVG blocks, port dots, arrow paths, labels, junctions
              → renderMappingPanel()
```

One panel is kept per mode (`block` / `dataflow`) in a static map, so reopening reveals
the existing panel instead of stacking duplicates. `retainContextWhenHidden` is on, and
the webview posts `ready` before the host flushes pending data — the host never posts
into a webview that has not booted.

### Override round-trip

```
User edits the mapping table (role dropdown, remove button, add dialog)
  → saveAndRefresh()
      → postMessage { command: 'saveOverrides', overrides }
          → overrideManager.saveOverrides() writes .uvm-assistant.json (empty keys stripped)
          → host echoes { command: 'overridesUpdated', overrides }
              → webview re-applies and re-renders
```

---

## 4. Key data structures

### UvmNode — `src/models/uvmNode.ts`

```typescript
interface UvmNode {
  className: string;            // "axi_driver"
  baseClass: string;            // "uvm_driver #(axi_txn)"
  uvmType: UvmType;             // 'test' | 'env' | 'agent' | 'driver' | 'monitor' | ...
  filePath: string;
  line: number;
  fields: UvmField[];           // { typeName, fieldName, line }
  children: UvmNode[];          // containment hierarchy
  tlmPorts: TlmPort[];          // { kind, paramType, fieldName }
  connections: TlmConnection[]; // { from: "drv.seq_item_port", to: "seqr.seq_item_export", line }
  virtualIfs: string[];         // virtual interface type names
}

interface DutInfo { moduleName: string; instanceName: string; filePath: string; line: number; }

interface TestbenchProject { name: string; rootDir: string; uvmRoots: UvmNode[]; duts: DutInfo[]; }
```

`UvmType` covers the classic roles plus the register model: `reg_block`, `reg`,
`reg_sequence`, `reg_adapter`, `reg_predictor`, `subscriber`.

### OverrideConfig — `src/models/overrides.ts`

```typescript
interface OverrideConfig {
  addedComponents?:    ComponentOverride[];   // { name, role, filePath, line?, instanceName? }
  removedComponents?:  string[];              // class/module names to hide
  roleOverrides?:      Record<string, string>;// className → role
  addedConnections?:   ConnectionOverride[];  // { from, to, label? }
  removedConnections?: ConnectionOverride[];  // matched on from+to
}
```

### Diagram internals — `webview/diagram.ts`

```typescript
interface BlockRect { x, y, w, h: number; node: UvmDiagramNode; kind: 'uvm' | 'dut'; stage: number; }
interface Arrow     { from: BlockRect; to: BlockRect; label, color, marker: string;
                      dashed: boolean; filePath?: string; line?: number; }
interface OccGrid   { data: Uint8Array; cols: number; rows: number; ox: number; oy: number; }
```

### Pipeline stages

`STAGE` maps a role to its column. Negative means "container" — drawn as a box that
wraps its children rather than occupying a column of its own.

```typescript
sequence: 0, reg_sequence: 0
sequencer: 1
driver: 2, reg_adapter: 2, component: 2
dut: 3
monitor: 4, reg_predictor: 4
scoreboard: 5, subscriber: 5
agent: -1, env: -1, test: -1, reg_block: -1, reg: -1, object: -1, unknown: -1
```

---

## 5. Classification and type resolution

`classifyUvmBase()` strips parameterization (`uvm_driver #(txn)` → `uvm_driver`) and looks
the base up in a fixed table.

Classes that extend a *user* base class come back `unknown`, so
`resolveUvmTypesTransitively()` runs over the flat workspace-wide class map and propagates
`uvmType` down inheritance chains until it reaches a fixed point (capped at 32 iterations).
It also retries on the unqualified name, so `my_pkg::my_mon_base` resolves.

This runs **before** per-project hierarchies are built — that ordering is what lets a base
class in a shared directory classify subclasses that live in other project directories.
`buildUvmHierarchy()` repeats the same propagation locally for classes scoped to one project.

---

## 6. DUT detection — `detectDuts()`

1. Files containing `run_test(` are testbench tops; modules declared in them are `tb_top` modules.
2. Candidate hosts are those `tb_top` modules, plus **companion tops** — uninstantiated
   modules in the same directory or sibling tree. This handles the split `top.sv` /
   `testbench.sv` pattern where the module calling `run_test()` instantiates nothing.
3. Every module instantiated by a host is scored:

   | Signal | Score |
   |---|---|
   | Binds a port to an interface published via `uvm_config_db#(virtual ...)::set(...)` | +100 |
   | Binds a port to any interface instance declared in the top | +50 |
   | Instance name matches `dut` / `u_dut` / `*_dut` | +30 |
   | Module body contains `always` / `assign` / `generate` | +20 |
   | Port count | +min(10, N) |
   | No ports at all | −40 |
   | Utility name (`clk_gen`, `checker`, `assertion`, `sva_`, …) | −100 |

4. Candidates scoring ≥ 50 win. Otherwise every positive-scoring candidate is returned.
   If nothing scores positive, it falls back to "all direct instances of the tops", so an
   oddly structured testbench still shows something.

Exercised by, among others, `emu-axi-uvm-main` (split top, DUT `axi_ram` in `hdl/top.sv`)
and `UVM_TestBench_For_Single_Port_RAM` (single `testbench.sv`, DUT `RAM` from `design.sv`).
Test projects live outside the repo at `/home/ayman/siework/uvm-assistant_tests/`.

---

## 7. Connection inference — `drawAllConnections()`

Arrows come from five sources, applied in order:

1. **Explicit TLM** — parsed from `connect_phase`; endpoints resolved field-name → class type.
2. **Inferred driver ↔ sequencer** — within an agent that has both, if not already connected.
3. **Driver → DUT and DUT → Monitor** — labelled with the virtual interface name, dashed, amber.
4. **Monitor/Agent → Scoreboard** — via analysis-port detection, only when the scoreboard
   has no explicit inbound connection.
5. **Overrides** — `removedConnections` filtered out, `addedConnections` appended.

Overrides match on `className` alone, so identically named components in different
projects can collide.

---

## 8. Routing engine

Grid-based orthogonal A*, introduced in v1.15.0, replacing the channel-based router that
[archive/routing-overhaul-plan.md](archive/routing-overhaul-plan.md) describes.

- **Grid**: `GRID = 10px` cells, `ROUTE_MARGIN = 1` cell of clearance.
- **Occupancy grid**: row-major `Uint8Array`. Solid blocks (`stage >= 0`) are impassable
  with margin; container borders (agent, env, test) are marked as obstacles while their
  interiors stay free, so a wire may enter a container but not cut its edge at random.
- **Direction-aware search**: states are `(col, row, dir)` with `dir ∈ {→, ↓, ←, ↑}` and a
  turn penalty of 3, which biases toward long straight runs.
- **Stubs**: `STUB_LEN = 16px` at both ends force the first and last segment to run
  rightward, which is what keeps every arrowhead pointing left-to-right.
- **Corridor clearing**: before each route, the source and target blocks are temporarily
  unblocked and a horizontal corridor is cut through container borders at port height.
  Cleared cells are restored immediately after.
- **Path marking**: a routed path marks a 3-cell-wide corridor so later wires do not overlap it.
  Shorter connections are routed first.
- **Fallback**: if A* finds nothing, the wire routes over the top of every block.

Port slots are assigned before routing: arrows sharing a block edge are sorted by the
opposite endpoint's Y (minimizing crossings), then spread `PORT_GAP` apart and centered on
the block. Block heights are sized from the pre-pass connection counts, so every arrow
gets its own slot.

---

## 9. Color scheme

| Role | Fill | Stroke |
|---|---|---|
| test | `#1a3a2a` | `#4ec9b0` |
| env | `#1a2a3a` | `#569cd6` |
| agent | `#1a2a1a` | `#6a9955` |
| driver | `#2a2010` | `#ce9178` |
| monitor | `#2a2a10` | `#dcdcaa` |
| sequencer | `#2a1a2a` | `#c586c0` |
| scoreboard | `#2a1515` | `#d16969` |
| sequence | `#152a2a` | `#b5cea8` |
| subscriber | `#2a2020` | `#f07a7a` |
| reg_block | `#2a2510` | `#f0c060` |
| reg | `#2a2518` | `#e6b48a` |
| reg_sequence | `#252a15` | `#d7d86b` |
| reg_adapter | `#2a2215` | `#d19a66` |
| reg_predictor | `#2a2815` | `#c4b454` |
| component | `#1a2a2a` | `#9cdcfe` |
| dut | `#1a1a2e` | `#e6b422` |

Connection colors: TLM `#8888cc`, analysis_port `#d16969`, seq_item `#c586c0`,
virtual interface `#e6b422` (dashed).

---

## 10. Diagram invariants

These hold by construction and any change to placement or routing must preserve them:

- A connection never crosses a solid block. Only containers (test, env, agent, reg_block)
  are permeable, and only through a cleared corridor.
- Every arrowhead points left-to-right.
- Arrow segments are strictly horizontal or vertical — no curves, no diagonals.
- Labels never overlap a block, a container, or another label.
- A label glows with its connection on hover (shared SVG group).
- Navigation is by **double**-click, on both diagrams — single click is reserved for pan.
