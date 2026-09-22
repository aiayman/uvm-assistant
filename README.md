# UVM-Assistant

A VS Code extension for analyzing Verilog/SystemVerilog workspaces with deep UVM support. Visualize module hierarchies, UVM class trees, and interactive testbench diagrams — plus real-time linting and formatting.

## Features

### Module Hierarchy
Discovers every module in the workspace and shows the instantiation tree in the sidebar. Click a module to jump to its source.

### UVM Class Hierarchy
Parses UVM classes, resolves inheritance and containment (via field declarations and `type_id::create()` calls), and shows the component tree. Roles are inherited down user-defined base classes, so `axi_monitor extends my_mon_base extends uvm_monitor` still classifies as a monitor.

### UVM Block Diagram
Nested-rectangle view of the component containment hierarchy. Pan, zoom, and double-click a block to open its source.

### UVM Data Flow Diagram
Pipeline view of the testbench laid out left-to-right by role:

```
Sequence → Sequencer → Driver → [DUT] → Monitor → Scoreboard
```

Connections are routed orthogonally with a grid A* router — arrows never cross a block, always enter from the left and exit to the right. Double-click an arrow to jump to the `connect_phase` line that created it.

### Mapping Table
A toggleable panel listing every detected component and connection. Reclassify a component's role, remove a false positive, or add something the parser missed. Edits persist to `.uvm-assistant.json` in the workspace root and are reapplied on every analysis.

### UVM Linter
Catches common UVM mistakes as you work:

| Rule | Severity | Description |
|------|----------|-------------|
| UVM001 | Error | Missing `uvm_component_utils` on component class |
| UVM002 | Error | Missing `uvm_object_utils` on object class |
| UVM003 | Error | Component class using `uvm_object_utils` instead of `uvm_component_utils` |
| UVM004 | Error | Object class using `uvm_component_utils` instead of `uvm_object_utils` |
| UVM005 | Warning | `build_phase` missing `super.build_phase()` call |
| UVM006 | Warning | `connect_phase` missing `super.connect_phase()` call |
| UVM007 | Warning | Hierarchical class (env/agent/test) missing `build_phase` |
| UVM008 | Info | TLM ports declared but no `connect_phase` |
| UVM009 | Info | Unnecessary `super.run_phase()` call |
| UVM010 | Warning | TLM port declared but not connected in `connect_phase` |
| UVM012 | Error | Agent has driver but `seq_item_port` not connected |
| UVM014 | Error | UVM component created with `new()` instead of `type_id::create()` |
| UVM016 | Warning | Component field declared but never created in `build_phase` |
| UVM018 | Info | `config_db::set()` with no matching `::get()` |
| UVM019 | Warning | `config_db::get()` not wrapped in `if(!...)` with `uvm_fatal` |
| UVM020 | Error | `config_db` type mismatch between `set` and `get` |
| UVM022 | Warning | Agent has driver but no sequencer |
| UVM023 | Warning | Agent has no monitor |

### Verible Formatter
Integrates [Verible](https://github.com/chipsalliance/verible) for document and range formatting. A pre-built binary is bundled, or point the extension at your own installation.

## Installation

### From VSIX
Download the latest `.vsix` from [Releases](https://github.com/aiayman/uvm-assistant/releases), then:

```bash
code --install-extension uvm-assistant-x.y.z.vsix
```

Or in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

### From source
```bash
git clone https://github.com/aiayman/uvm-assistant.git
cd uvm-assistant
npm install
npm run package
code --install-extension uvm-assistant-*.vsix
```

## Usage

1. Open a folder containing `.sv`, `.v`, `.svh`, or `.vh` files.
2. Click the **UVM-Assistant** icon in the Activity Bar.
3. The extension scans and analyzes the workspace automatically. Files excluded by `.gitignore` are skipped.
4. Analysis re-runs on file changes; use **Refresh** to force it.

### Commands

| Command | Description |
|---------|-------------|
| `UVM-Assistant: Refresh Analysis` | Re-scan and re-analyze the workspace |
| `UVM-Assistant: Open UVM Block Diagram` | Component containment diagram |
| `UVM-Assistant: Open UVM Data Flow Diagram` | Pipeline diagram with routed connections |
| `UVM-Assistant: Format with Verible` | Format the active document |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `uvm-assistant.verible.path` | `verible-verilog-format` | Path to the Verible formatter binary |
| `uvm-assistant.verible.columnLimit` | `100` | Maximum column width for formatting |
| `uvm-assistant.verible.portDeclarationsAlignment` | `infer` | Port alignment: `align`, `flush-left`, `preserve`, `infer` |
| `uvm-assistant.verible.tryWrapLongLines` | `true` | Attempt to wrap long lines |

### `.uvm-assistant.json`

Written by the mapping table, and safe to edit by hand. All keys are optional:

```json
{
  "addedComponents":   [{ "name": "my_ram", "role": "dut", "filePath": "/abs/path/ram.sv", "line": 1 }],
  "removedComponents": ["clk_gen"],
  "roleOverrides":     { "my_custom_checker": "scoreboard" },
  "addedConnections":  [{ "from": "my_monitor", "to": "my_scoreboard", "label": "analysis_port" }],
  "removedConnections":[{ "from": "my_driver", "to": "my_ram" }]
}
```

## Architecture

The extension uses a dual-parsing strategy: **tree-sitter** (via WebAssembly) for AST parsing when the SystemVerilog grammar is available, with a **regex fallback** that also supplements tree-sitter with UVM macro and field detection. Parse results feed the hierarchy builders, linter, and diagram renderers; file contents are read once and shared across all consumers.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internals and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the build and release workflow.

## License

MIT
