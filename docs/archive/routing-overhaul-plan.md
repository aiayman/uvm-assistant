# UVM Data-Flow Diagram: Placement & Routing Overhaul Plan

> **Archived — superseded.** This plan describes the *channel-based* router that shipped in
> v1.12.0. It was replaced in v1.15.0 by the grid-based A\* router, so the routing sections
> below no longer describe the code. The placement design (stage columns, cell sizing, agent
> grouping) is still broadly accurate. Kept for the constraints in "Constraints
> (Non-Negotiable)" and the reasoning behind them. For what the code does today, see
> [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Problem Statement

The current layout and routing code has accumulated incremental patches that don't address the root issues. The result is arrows that strike through blocks, inclined/diagonal segments, poor vertical channel usage, and connection-point overlap. The code needs a clean, structured overhaul of both **placement** (where blocks go) and **routing** (how arrows travel between them).

---

## Constraints (Non-Negotiable)

| ID | Rule |
|---|---|
| C1 | An arrow may **never** strike through any block or container border |
| C2 | Input ports exist on the **left** side of a block; arrowheads always point **right** (→) |
| C3 | Output ports exist on the **right** side of a block |
| C4 | Arrows consist of **only** horizontal and vertical segments — no curves, no diagonals |
| C5 | Arrows must stay **inside** the outermost container (env or test) |
| C6 | Minimum spacing (`TRACK_SPACING`) between parallel arrow segments |
| C7 | Minimum spacing between an arrow and any block edge it passes (`BLOCK_ARROW_GAP`) |

---

## Architecture: Two Clearly Separated Phases

```
Phase 1: PLACEMENT (cell sizing + grid placement)
         ↓ produces a positioned list of rectangular cells
Phase 2: ROUTING  (port assignment + channel routing)
         ↓ produces strictly-orthogonal polyline paths
```

These two phases are **independent**. Placement never considers wires. Routing only reads the placed rectangles.

---

## Phase 1 — Placement

### 1.1 Cell Abstraction

Every visual element is a **Cell**:

```
interface Cell {
  id: string;           // className or DUT moduleName
  kind: 'leaf' | 'agent' | 'dut' | 'seq-group';
  stage: number;        // pipeline column (0=seq, 1=seqr, 2=drv, 3=dut, 4=mon, 5=sb)
  w: number;            // outer width  (includes internal padding)
  h: number;            // outer height
  children?: Cell[];    // only for agent groups
  leftPortCount: number;   // # of input connections
  rightPortCount: number;  // # of output connections
}
```

### 1.2 Sizing Rules

**Leaf blocks** (driver, monitor, sequencer, scoreboard, sequence, component):

```
w = max(BLOCK_MIN_W, textWidth + iconSpace)
h = max(BLOCK_MIN_H, max(leftPortCount, rightPortCount) * PORT_GAP + 2 * PORT_MARGIN)
```

- Port count comes from a **pre-pass** that counts how many arrows will connect to each side.
- This guarantees every port has its own vertical slot — no overlaps.

**Agent groups:**

```
w = max(child widths) + 2 * AGENT_PAD
h = HEADER_H + sum(child heights) + (n-1) * CHILD_GAP + 2 * AGENT_PAD
```

- Members stacked vertically in pipeline order: sequencer → driver → monitor.
- The agent box wraps tightly around its children.

**DUT blocks:**

```
w = DUT_W (fixed 140)
h = max(DUT_H, leftPortCount * PORT_GAP + 2 * PORT_MARGIN)
```

**Sequence groups:** Same as agent groups but without the header.

### 1.3 Grid Placement

Blocks are placed in a **column grid** indexed by pipeline `stage`:

```
Column 0: sequences
Column 1: sequencers (inside agents)
Column 2: drivers    (inside agents)
Column 3: DUTs
Column 4: monitors   (inside agents)
Column 5: scoreboards
```

**Layout algorithm:**

1. Measure every cell (bottom-up: leaves first, then groups).
2. Assign each cell to its stage column.
3. For each column, stack cells vertically with `COL_GAP_Y` spacing, centered on the column's Y midpoint.
4. Space columns left-to-right with `COL_GAP_X` between them.
5. Compute container boxes (env, test) to envelop all their children plus padding.

**Key difference from current code:** The current code places all blocks in a single row at `baseY + verticalCenter`. This forces all agents, DUTs, and scoreboards into one horizontal band. The new approach uses **per-column vertical stacking**, so if there are two agents, they stack vertically within their column without overlapping. DUTs center themselves vertically between the driver and monitor they serve.

### 1.4 Routing Channels

Between each pair of adjacent columns, reserve a **routing channel** of width `CHANNEL_W`:

```
CHANNEL_W = max(CHANNEL_MIN_W, numWiresCrossing * TRACK_SPACING)
```

This is computed **after** the port-assignment pre-pass (Phase 2.1) so we know how many wires cross each column gap.

The column X positions are then:

```
col[0].x = envPad
col[i].x = col[i-1].x + col[i-1].maxW + channel[i-1].w
```

This ensures there is always clear horizontal space between columns for vertical wire segments to pass without touching blocks.

### 1.5 Agent Internal Layout

Within an agent group, children are stacked vertically:

```
  ┌─ agent ──────────────────────┐
  │  [sequencer]                 │
  │       ↕ CHILD_GAP            │
  │  [driver]                    │
  │       ↕ CHILD_GAP            │
  │  [monitor]                   │
  └──────────────────────────────┘
```

Children are left-aligned within the agent (with `AGENT_PAD` on each side). This means:
- Right ports of children are at `agent.x + agent.w - AGENT_PAD + child.w` in absolute coords.
- Left ports of children are at `agent.x + AGENT_PAD`.

---

## Phase 2 — Routing

### 2.1 Port Assignment (Pre-Pass)

Before routing, assign every arrow a **specific port slot** on both the source and target block.

```
interface PortSlot {
  blockId: string;
  side: 'left' | 'right';
  index: number;     // 0-based slot from top
  x: number;         // absolute X (on block edge)
  y: number;         // absolute Y (computed from index * PORT_GAP + offset)
}
```

**Algorithm:**

1. Collect all arrows. For each arrow, record the source block (right side) and target block (left side).
2. Group arrows by block+side. Sort each group by the Y coordinate of the **other** endpoint (this minimizes crossings).
3. Assign slot indices 0, 1, 2, ... to each arrow in the sorted group.
4. Compute Y position: `blockY + topMargin + slotIndex * PORT_GAP`.

**Multi-connection detection:** If two arrows share the same logical port (e.g., `ap_mon` connecting to both scoreboard and coverage), they get consecutive slots but share a **junction** marker at the block edge.

### 2.2 Channel-Based Orthogonal Router

Every arrow goes: **source port → horizontal → vertical channel → horizontal → target port**.

The basic shape is always a **Z** or **U** depending on relative positions:

```
Forward (target right of source):     Backward (target left of source):

  src ──────┐                           ┌──────── src
            │                           │
            │  (vertical in channel)    │
            │                           │
            └────── tgt                 tgt ──────┘
```

**Step-by-step for each arrow:**

1. **Exit horizontal:** From `srcPort.x` go right by `STUB_LEN` (short horizontal stub leaving the block).
2. **Pick a vertical channel:** The channel between the source column and target column. If the arrow goes forward, use the channel to the right of the source column. If backward, route above/below.
3. **Vertical segment:** Travel from `srcPort.y` to `tgtPort.y` in the chosen channel.
4. **Entry horizontal:** Go right to `tgtPort.x`.

**Channel track assignment:**

Within each routing channel, vertical segments are assigned to **tracks** (parallel vertical lanes spaced `TRACK_SPACING` apart):

```
channel.x + trackIndex * TRACK_SPACING
```

Tracks are assigned left-to-right based on the Y-span of each wire, using a greedy left-edge algorithm:

1. Sort wires crossing this channel by their top Y coordinate.
2. For each wire, assign it to the leftmost track that doesn't overlap with an already-assigned wire in Y range.

This guarantees no two vertical segments in the same channel overlap or touch.

### 2.3 Collision Avoidance

With the channel-based approach, collisions are **structurally impossible** if:

- Horizontal stubs stay within the gap between a block edge and the channel boundary (guaranteed by `STUB_LEN < CHANNEL_W`).
- Vertical segments are confined to channel tracks (never inside a column).
- The routing channel width was computed to fit all crossing wires.

**Edge case — backward routing (target is to the left of source):**

Route above or below all blocks:
1. Exit right with a stub.
2. Vertical up/down to a **perimeter track** (above the topmost block or below the bottommost).
3. Horizontal across the full width to a perimeter track on the target side.
4. Vertical down/up to the target's Y.
5. Horizontal into the target port from the left.

The perimeter tracks are allocated just inside the container bounds with `PERIMETER_MARGIN`.

### 2.4 Same-Column Connections (Agent Internals)

Connections between blocks in the same agent (e.g., sequencer → driver):

1. Exit right from sequencer's right port.
2. Short horizontal stub into the agent's internal routing space.
3. Vertical down to the driver's Y.
4. Horizontal left into the driver's left port.

These are routed in a small channel between the right edge of the children and the agent's right border.

### 2.5 Post-Route Validation

After all paths are computed, run a validation pass:

```
for each segment in each path:
  for each block:
    assert: segment does not intersect block (with BLOCK_ARROW_GAP margin)
    assert: segment is axis-aligned (dx == 0 or dy == 0)
  assert: segment stays within containerBounds
```

Any violations are logged for debugging. In practice, the channel-based router should produce zero violations by construction.

---

## Phase 3 — Drawing

### 3.1 Port Indicators

On each block, draw port indicators at the assigned slot positions:

- **Output ports (right side):** Filled circle (analysis_port, put_port, seq_item_port).
- **Input ports (left side):** Filled square for exports/imps, filled circle for others.
- **Labels:** Port field name, anchored outward from the block edge.

Port indicators are drawn at the exact `PortSlot.y` positions, guaranteeing alignment with the arriving arrow.

### 3.2 Arrow Drawing

For each routed path (list of `{x, y}` waypoints):

1. Build an SVG `<path>` using only `M` and `L` commands (no `Q`, no `C`).
2. Attach `marker-end` for the arrowhead.
3. If `filePath` + `line` are present, attach a click handler.

### 3.3 Junction Indicators

At block-edge points where multiple arrows converge (shared port):

- Draw a vertical **bus bar**: a rounded rectangle spanning the Y range of the converging ports.
- Color matches the connection type.

---

## Implementation Plan (Ordered Steps)

### Step 1: Define data structures

- `Cell`, `PortSlot`, `RoutingChannel`, `Track` interfaces.
- Replace loose `drawnBlocks` array with a `PlacedCell` structure that includes absolute coordinates.

### Step 2: Rewrite placement (`renderProject`)

- Implement column-based grid layout.
- Compute routing channel widths.
- Size blocks with port-count-aware height.
- Draw containers, then blocks.

### Step 3: Implement port assignment

- Pre-pass to count and assign port slots per block side.
- Compute absolute (x, y) for each port slot.

### Step 4: Implement channel router

- For each arrow: exit stub → pick channel track → vertical segment → entry stub.
- Track assignment within channels (greedy left-edge).
- Backward routing via perimeter tracks.
- Agent-internal routing.

### Step 5: Implement drawing

- `drawOrthoArrow`: strictly `M`/`L` path, arrowhead marker, click handler.
- `drawPorts`: port indicators at assigned slot positions.
- `drawJunctions`: bus bars at shared ports.

### Step 6: Validation & cleanup

- Post-route collision assertion.
- Remove all dead code (old routing functions, `CORNER_R`, unused helpers).
- Test with multiple testbench projects (RAM, SPI, etc.).

---

## Constants (Proposed Values)

```typescript
const BLOCK_MIN_W    = 140;   // minimum block width
const BLOCK_MIN_H    = 56;    // minimum block height
const PORT_GAP       = 18;    // vertical distance between port slots
const PORT_MARGIN    = 14;    // top/bottom margin for first/last port
const COL_GAP_X      = 24;    // minimum horizontal gap between columns
const CHILD_GAP      = 20;    // vertical gap between children in an agent
const AGENT_PAD      = 20;    // padding inside agent container
const CHANNEL_MIN_W  = 30;    // minimum routing channel width
const TRACK_SPACING  = 12;    // spacing between parallel vertical tracks
const STUB_LEN       = 16;    // horizontal stub leaving/entering a block
const BLOCK_ARROW_GAP = 8;    // min gap between arrow and block edge
const PERIMETER_MARGIN = 20;  // gap between container edge and perimeter tracks
```

---

## Questions for Clarification

1. **Agent groups with only a driver or only a monitor** (no sequencer) — should they still be drawn inside an agent box, or as standalone blocks?

2. **Multiple agents in the same environment** — should they stack vertically in the same column, or should each agent get its own column position? (Currently they're in the same column.)

3. **DUT positioning when there are multiple agents** — should each DUT be vertically aligned with its connected driver/monitor pair, or should DUTs be in a single centered column?

4. **Sequence → Sequencer connections** — these are implicit (not from `connect_phase`). Should they be shown? If so, should they route from the sequence group (column 0) through a channel to the sequencer (column 1)?

5. **Container nesting** — currently test wraps env which wraps everything. Is there a case where you'd want multiple envs or partial containment? Or is the single test→env→(agents+others) hierarchy always correct?
