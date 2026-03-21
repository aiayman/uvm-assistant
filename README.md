# UVM-Assistant

A VS Code extension for analyzing Verilog/SystemVerilog workspaces with deep UVM support. Visualize module hierarchies, UVM class trees, and interactive block diagrams — plus get real-time linting and formatting.

## Features

### Module Hierarchy
Automatically discovers all modules across your workspace and displays the instantiation tree in the sidebar. Click any module to jump to its source.

### UVM Class Hierarchy
Parses UVM classes, resolves inheritance and containment (via field declarations and `type_id::create()` calls), and displays the component tree.

### UVM Block Diagram
Interactive SVG diagram showing your UVM testbench architecture. Pan, zoom, and click any block to open the source file.

### UVM Linter (22+ Rules)
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
Integrates [Verible](https://github.com/chipsalliance/verible) for document and range formatting. A pre-built binary is bundled, or you can point to your own installation.

## Installation

### From VSIX
Download the latest `.vsix` from [Releases](https://github.com/aiayman/uvm-assistant/releases), then:

```
code --install-extension uvm-assistant-x.y.z.vsix
```

Or in VS Code: `Ctrl+Shift+P` > `Extensions: Install from VSIX...`

### From Source
```bash
git clone https://github.com/aiayman/uvm-assistant.git
cd uvm-assistant
npm install
npm run package
code --install-extension uvm-assistant-*.vsix
```

## Usage

1. Open a folder containing `.sv`, `.v`, `.svh`, or `.vh` files
2. Click the **UVM-Assistant** icon in the Activity Bar
3. The extension automatically scans and analyzes your workspace
4. Use the **Refresh** button to re-analyze after changes

### Commands

| Command | Description |
|---------|-------------|
| `UVM-Assistant: Refresh Analysis` | Re-scan and re-analyze the workspace |
| `UVM-Assistant: Open UVM Block Diagram` | Show interactive UVM architecture diagram |
| `UVM-Assistant: Format with Verible` | Format the active document |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `uvm-assistant.verible.path` | `verible-verilog-format` | Path to the Verible formatter binary |
| `uvm-assistant.verible.columnLimit` | `100` | Maximum column width for formatting |
| `uvm-assistant.verible.portDeclarationsAlignment` | `infer` | Port alignment: `align`, `flush-left`, `preserve`, `infer` |
| `uvm-assistant.verible.tryWrapLongLines` | `true` | Attempt to wrap long lines |

## Architecture

The extension uses a dual-parsing strategy:
- **Tree-sitter** (via WebAssembly) for fast, accurate AST parsing when the SystemVerilog grammar is available
- **Regex fallback** for environments where the grammar WASM isn't bundled, and to supplement tree-sitter with UVM macro detection

Parsing results feed into the hierarchy builders, linter, and diagram renderer. File contents are read once and shared across all consumers.

## License

MIT
