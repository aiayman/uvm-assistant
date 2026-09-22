# Changelog

All notable changes to UVM-Assistant. Dates and contents are taken from the git tags.

## [1.18.0] — 2026-04-15

- **Register model support.** `uvm_reg_block`, `uvm_reg`, `uvm_reg_sequence`,
  `uvm_reg_adapter`, `uvm_reg_predictor`, `uvm_subscriber`, `uvm_push_driver`,
  `uvm_push_sequencer`, `uvm_transaction` and `uvm_sequence_item` are now recognized, with
  their own pipeline stages, themes, icons and mapping-table roles. `reg_block` is treated
  as a container and recursed into like `env` and `agent`.
- **Derived-class classification is now global.** `resolveUvmTypesTransitively()` runs over
  the whole workspace before per-project hierarchies are built, so a user base class in a
  shared directory classifies its subclasses in other project directories.
- **Parser handles parameterization.** `CLASS_DECL_RE` accepts
  `class foo #(type T) extends bar #(T);` and `MODULE_INST_RE` accepts instantiations with
  nested parens, e.g. `Module #(.P(mode)) inst (...)` — needed for SPI-style testbenches.
- **Smarter DUT detection.** Candidates are scored on interface binding, instance naming,
  RTL constructs and port count, with penalties for utility modules. Falls back to the
  previous behavior when nothing scores.
- Block-diagram navigation moved to double-click, matching the data flow diagram.

## [1.17.0] — 2026-04-14

- Workspace scanning respects `.gitignore`, including negation, rooted patterns,
  directory-only patterns and globs. Changes to `.gitignore` re-trigger analysis.

## [1.16.0] — 2026-03-26

- Smart DUT detection from testbench tops, including the split `top.sv` / `testbench.sv` pattern.
- **Mapping table**: a toggleable panel listing detected components and connections, with
  full add / remove / reclassify editing, persisted to `.uvm-assistant.json`.

## [1.15.3] — 2026-03-23

- Connection labels glow with their arrow on hover.

## [1.15.2] — 2026-03-23

- Connections avoid container borders, arrowheads always face right, labels no longer overlap.

## [1.15.1] — 2026-03-23

- Connections no longer strike through solid blocks.

## [1.15.0] — 2026-03-23

- **Grid-based A\* router** replaces the channel-based router: direction-aware search with
  a turn penalty, an occupancy grid with permeable container interiors, and routing stubs
  that guarantee left-to-right arrowheads.

## [1.14.0] — 2026-03-23

- Horizontal agent layout, override filtering, double-click navigation, improved clearance.

## [1.13.0] — 2026-03-23

- Vertical stacking within stage columns, label collision avoidance, diagonal elimination.

## [1.12.0] — 2026-03-23

- Complete placement and routing overhaul on a channel-based architecture.

## [1.11.0] — 2026-03-23

- Strict orthogonal arrows, port spacing, collision fixes, bus junctions at shared ports.

## [1.10.0] — 2026-03-23

- Smarter arrow routing, arrowhead fix, all connections clickable.

## [1.9.0] — 2026-03-23

- Arrow hover effects, container-bound routing, directional ports, click-to-navigate.

## [1.8.0] — 2026-03-22

- Port shapes, full collision-aware routing, improved deconfliction.

## [1.7.0] — 2026-03-22

- Orthogonal arrow routing with track deconfliction.

## [1.6.0] — 2026-03-22

- Collision-avoiding arrows, connection-aware block sizing, legend arrow icons.

## [1.5.1] — 2026-03-22

- Legend icons, improved arrow deconfliction.

## [1.5.0] — 2026-03-22

- Legend overlap fix, arrow routing improvements, multi-project dropdown, sequence grouping.

> 1.2.0 – 1.4.0 were packaged locally but never tagged; their changes landed in 1.5.0.

## [1.1.0] — 2026-03-22

- Version bump.

## [1.0.0] — 2026-03-22

- Dual diagrams (block + data flow), TLM port parsing, connection arrows, distinctive icons.

## [0.3.0] — 2026-03-22

- Initial release: module hierarchy, UVM class hierarchy, UVM linter, Verible formatter,
  GitHub Actions release workflow.
