/**
 * UVM Data Flow Diagram — grid-based placement & routing.
 *
 * Blocks are arranged left-to-right by their role in the UVM data pipeline:
 *   Sequence → Sequencer → Driver → [DUT] → Monitor → Scoreboard
 *
 * Container blocks (test, env, agent) act as grouping boxes.
 * Arrows are routed through dedicated channels between columns.
 * All arrow segments are strictly horizontal or vertical.
 */

interface TlmPort { kind: string; paramType: string; fieldName: string; }
interface TlmConnection { from: string; to: string; line?: number; }
interface UvmField { typeName: string; fieldName: string; }

interface UvmDiagramNode {
  className: string;
  uvmType: string;
  baseClass: string;
  filePath: string;
  line: number;
  children: UvmDiagramNode[];
  fields: UvmField[];
  tlmPorts: TlmPort[];
  connections: TlmConnection[];
  virtualIfs: string[];
}

interface DutInfo {
  moduleName: string;
  instanceName: string;
  filePath: string;
  line: number;
}

interface ProjectData {
  name: string;
  roots: UvmDiagramNode[];
  duts: DutInfo[];
}

const vscode = (window as any).acquireVsCodeApi();

// ─── Layout constants ─────────────────────────────────────────
const PAD = 20;
const HEADER_H = 44;
const BLOCK_MIN_W = 140;
const BLOCK_MIN_H = 56;
const GAP_X = 24;
const GAP_Y = 20;
const LABEL_Y = 18;
const TYPE_Y = 32;
const ICON_SIZE = 16;
const PORT_R = 5;
const PORT_GAP = 18;
const CHAR_W = 7.5;
const DUT_W = 140;
const DUT_H = 80;
const TRACK_SPACING = 12;
const BLOCK_ARROW_GAP = 14;
const PORT_CIRCLE_R = 3.5;
const PORT_MARGIN = 14;
const CHILD_GAP = 20;
const AGENT_PAD = 20;
const CHANNEL_MIN_W = 40;
const STUB_LEN = 16;
const PERIMETER_MARGIN = 16;

// Grid routing
const GRID = 10;
const ROUTE_MARGIN = 1;
function snap(v: number): number { return Math.round(v / GRID) * GRID; }

// Pipeline stage order (lower = further left)
const STAGE: Record<string, number> = {
  sequence: 0, sequencer: 1, driver: 2,
  dut: 3,
  monitor: 4, scoreboard: 5,
  agent: -1, env: -1, test: -1,
  component: 2, object: -1, unknown: -1,
};

// ─── Color themes ─────────────────────────────────────────────
interface Theme { fill: string; stroke: string; accent: string }
const THEMES: Record<string, Theme> = {
  test:       { fill: '#1a3a2a', stroke: '#4ec9b0', accent: '#4ec9b0' },
  env:        { fill: '#1a2a3a', stroke: '#569cd6', accent: '#569cd6' },
  agent:      { fill: '#1a2a1a', stroke: '#6a9955', accent: '#6a9955' },
  driver:     { fill: '#2a2010', stroke: '#ce9178', accent: '#ce9178' },
  monitor:    { fill: '#2a2a10', stroke: '#dcdcaa', accent: '#dcdcaa' },
  sequencer:  { fill: '#2a1a2a', stroke: '#c586c0', accent: '#c586c0' },
  scoreboard: { fill: '#2a1515', stroke: '#d16969', accent: '#d16969' },
  sequence:   { fill: '#152a2a', stroke: '#b5cea8', accent: '#b5cea8' },
  component:  { fill: '#1a2a2a', stroke: '#9cdcfe', accent: '#9cdcfe' },
  object:     { fill: '#222',    stroke: '#888',    accent: '#888'    },
  dut:        { fill: '#1a1a2e', stroke: '#e6b422', accent: '#e6b422' },
  unknown:    { fill: '#222',    stroke: '#666',    accent: '#666'    },
};

// ─── State ────────────────────────────────────────────────────
let svgEl: SVGSVGElement;
let rootG: SVGGElement;
let currentTransform = { x: 0, y: 0, k: 1 };

interface BlockRect {
  x: number; y: number; w: number; h: number;
  node: UvmDiagramNode; kind: 'uvm' | 'dut';
  stage: number;
}
let drawnBlocks: BlockRect[] = [];
let drawnContainers: { x: number; y: number; w: number; h: number }[] = [];
let drawnLabels: { x: number; y: number; w: number; h: number }[] = [];

// ─── Project state ────────────────────────────────────────────
let allProjects: ProjectData[] = [];
let selectedProjectIndex = 0;

// ─── SVG helpers ──────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
function el(tag: string): SVGElement { return document.createElementNS(NS, tag); }
function attrs(e: SVGElement, a: Record<string, string | number>): SVGElement {
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
  return e;
}

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  svgEl = document.getElementById('diagram') as unknown as SVGSVGElement;
  rootG = el('g') as SVGGElement;
  svgEl.appendChild(rootG);

  const defs = el('defs');
  defs.innerHTML = `
    <marker id="ah" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6" fill="#8888cc"/>
    </marker>
    <marker id="ah-dut" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6" fill="#e6b422"/>
    </marker>
    <marker id="ah-ap" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6" fill="#d16969"/>
    </marker>
    <marker id="ah-seq" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6" fill="#c586c0"/>
    </marker>`;
  svgEl.appendChild(defs);

  setupZoomPan();
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoom(1.2));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoom(0.8));
  document.getElementById('btn-reset')?.addEventListener('click', resetView);

  const dropdown = document.getElementById('project-dropdown') as HTMLSelectElement | null;
  if (dropdown) {
    dropdown.addEventListener('change', () => {
      selectedProjectIndex = dropdown.selectedIndex;
      if (allProjects[selectedProjectIndex]) {
        const p = allProjects[selectedProjectIndex];
        renderProject(p.roots, p.duts);
      }
    });
  }

  vscode.postMessage({ command: 'ready' });
});

window.addEventListener('message', (ev) => {
  if (ev.data.command === 'renderDiagram') {
    const projects: ProjectData[] = ev.data.projects || [];
    allProjects = projects;
    selectedProjectIndex = 0;
    updateProjectDropdown();
    if (projects.length > 0) {
      const p = projects[selectedProjectIndex];
      renderProject(p.roots, p.duts);
    } else {
      renderProject([], []);
    }
  }
});

function updateProjectDropdown(): void {
  const dropdown = document.getElementById('project-dropdown') as HTMLSelectElement | null;
  if (!dropdown) return;
  if (allProjects.length <= 1) { dropdown.style.display = 'none'; return; }
  dropdown.style.display = 'block';
  dropdown.innerHTML = '';
  for (let i = 0; i < allProjects.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = allProjects[i].name;
    if (i === selectedProjectIndex) opt.selected = true;
    dropdown.appendChild(opt);
  }
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  CORE PIPELINE — Placement, Routing, Drawing                ║
// ╚══════════════════════════════════════════════════════════════╝

type Pt = { x: number; y: number };

interface Arrow {
  from: BlockRect; to: BlockRect;
  label: string; color: string;
  marker: string; dashed: boolean;
  filePath?: string; line?: number;
}

// ─── Helpers ─────────────────────────────────────────────────
function resolveFieldToClass(parent: UvmDiagramNode, fieldName: string): string | undefined {
  for (const f of parent.fields) { if (f.fieldName === fieldName) return f.typeName; }
  for (const ch of parent.children) { if (ch.className.toLowerCase() === fieldName.toLowerCase()) return ch.className; }
  return undefined;
}
function findBlockByClass(className: string): BlockRect | undefined {
  return drawnBlocks.find(b => b.node.className === className);
}
function isOutputPort(kind: string): boolean {
  return kind.includes('analysis_port') || kind.includes('put_port') || kind.includes('seq_item_port');
}
function absPos(e: SVGElement): { x: number; y: number } {
  let x = 0, y = 0; let cur: SVGElement | null = e;
  while (cur && cur !== rootG) {
    const t = cur.getAttribute('transform');
    if (t) { const m = t.match(/translate\(([\d.-]+),([\d.-]+)\)/); if (m) { x += parseFloat(m[1]); y += parseFloat(m[2]); } }
    cur = cur.parentElement as SVGElement | null;
  }
  return { x, y };
}

// ─── Measure a leaf component ─────────────────────────────────
function measureLeaf(node: UvmDiagramNode, connCounts: Map<string, number>): { w: number; h: number } {
  const textW = node.className.length * CHAR_W + PAD * 2 + ICON_SIZE + 8;
  const leftCount = connCounts.get(node.className + ':L') || 0;
  const rightCount = connCounts.get(node.className + ':R') || 0;
  const portCount = Math.max(leftCount, rightCount, 1);
  const portH = portCount * PORT_GAP + 2 * PORT_MARGIN;
  return { w: Math.max(BLOCK_MIN_W, textW), h: Math.max(BLOCK_MIN_H, portH) };
}

// ─── Connection count pre-pass (counts per side) ─────────────
function countConnections(roots: UvmDiagramNode[], duts: DutInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  const inc = (name: string, side: 'L' | 'R') => {
    const key = name + ':' + side;
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  const processConns = (node: UvmDiagramNode) => {
    for (const conn of node.connections) {
      const srcClass = resolveFieldToClass(node, conn.from.split('.')[0]);
      const dstClass = resolveFieldToClass(node, conn.to.split('.')[0]);
      if (srcClass) inc(srcClass, 'R');
      if (dstClass) inc(dstClass, 'L');
    }
    for (const ch of node.children) processConns(ch);
  };
  for (const r of roots) processConns(r);

  const inferAgent = (node: UvmDiagramNode) => {
    if (node.uvmType === 'agent') {
      const drv = node.children.find(c => c.uvmType === 'driver');
      const seqr = node.children.find(c => c.uvmType === 'sequencer');
      if (drv && seqr) { inc(seqr.className, 'R'); inc(drv.className, 'L'); }
    }
    for (const ch of node.children) inferAgent(ch);
  };
  for (const r of roots) inferAgent(r);

  if (duts.length > 0) {
    const collectDM = (n: UvmDiagramNode) => {
      if (n.uvmType === 'driver') { inc(n.className, 'R'); for (const d of duts) inc(d.moduleName, 'L'); }
      if (n.uvmType === 'monitor') { inc(n.className, 'L'); for (const d of duts) inc(d.moduleName, 'R'); }
      for (const ch of n.children) collectDM(ch);
    };
    for (const r of roots) collectDM(r);
  }

  const collectSbAp = (n: UvmDiagramNode) => {
    if (n.uvmType === 'scoreboard') inc(n.className, 'L');
    if ((n.uvmType === 'monitor' || n.uvmType === 'agent') && n.tlmPorts.some(p => p.kind.includes('analysis'))) inc(n.className, 'R');
    for (const ch of n.children) collectSbAp(ch);
  };
  for (const r of roots) collectSbAp(r);

  return counts;
}

// ═══════════════════════════════════════════════════════════════
// ═ PHASE 1: PLACEMENT
// ═══════════════════════════════════════════════════════════════

interface AgentGroup {
  agent?: UvmDiagramNode;
  env?: UvmDiagramNode;
  test?: UvmDiagramNode;
  members: UvmDiagramNode[];
}

// Split agent members into rows: sequencer+driver horizontal, monitor below
function agentRows(members: UvmDiagramNode[]): { row1: UvmDiagramNode[]; row2: UvmDiagramNode[] } {
  const seqDrv = members.filter(m => m.uvmType === 'sequencer' || m.uvmType === 'driver');
  const other = members.filter(m => m.uvmType !== 'sequencer' && m.uvmType !== 'driver');
  if (seqDrv.length === 0) return { row1: members, row2: [] };
  return { row1: seqDrv, row2: other };
}

function renderProject(roots: UvmDiagramNode[], duts: DutInfo[]): void {
  const empty = document.getElementById('empty-state')!;
  const ctr = document.getElementById('diagram-container')!;
  if (roots.length === 0) { empty.style.display = 'flex'; ctr.style.display = 'none'; clearLegend(); return; }
  empty.style.display = 'none'; ctr.style.display = 'block';
  while (rootG.firstChild) rootG.removeChild(rootG.firstChild);
  drawnBlocks = [];
  drawnContainers = [];
  drawnLabels = [];

  // Pre-pass: count connections per block per side
  const connCounts = countConnections(roots, duts);

  // Collect all leaf components from the UVM tree
  const allLeaves: { node: UvmDiagramNode; ancestors: UvmDiagramNode[] }[] = [];
  const collectLeaves = (n: UvmDiagramNode, ancestors: UvmDiagramNode[]) => {
    const pipelineChildren = n.children.filter(c => STAGE[c.uvmType] >= 0);
    const nonPipelineChildren = n.children.filter(c => STAGE[c.uvmType] < 0 && c.children.some(gc => STAGE[gc.uvmType] >= 0));
    if (pipelineChildren.length > 0) {
      for (const ch of pipelineChildren) allLeaves.push({ node: ch, ancestors: [...ancestors, n] });
    }
    for (const ch of [...nonPipelineChildren, ...n.children.filter(c => c.uvmType === 'agent' || c.uvmType === 'env')]) {
      collectLeaves(ch, [...ancestors, n]);
    }
    if (pipelineChildren.length === 0 && nonPipelineChildren.length === 0 && STAGE[n.uvmType] >= 0) {
      allLeaves.push({ node: n, ancestors });
    }
  };
  for (const r of roots) collectLeaves(r, []);

  // Group by agent parent
  const agentGroups: AgentGroup[] = [];
  const standaloneLeaves: { node: UvmDiagramNode; env?: UvmDiagramNode; test?: UvmDiagramNode }[] = [];
  for (const leaf of allLeaves) {
    const agentAncestor = leaf.ancestors.find(a => a.uvmType === 'agent');
    const envAncestor = leaf.ancestors.find(a => a.uvmType === 'env');
    const testAncestor = leaf.ancestors.find(a => a.uvmType === 'test');
    if (agentAncestor) {
      let group = agentGroups.find(g => g.agent === agentAncestor);
      if (!group) { group = { agent: agentAncestor, env: envAncestor, test: testAncestor, members: [] }; agentGroups.push(group); }
      if (!group.members.includes(leaf.node)) group.members.push(leaf.node);
    } else {
      if (!standaloneLeaves.some(s => s.node === leaf.node)) standaloneLeaves.push({ node: leaf.node, env: envAncestor, test: testAncestor });
    }
  }
  for (const g of agentGroups) g.members.sort((a, b) => (STAGE[a.uvmType] ?? 99) - (STAGE[b.uvmType] ?? 99));

  // Filter out type-override classes — subclasses of components already in agents
  const agentMemberClasses = new Set<string>();
  for (const g of agentGroups) for (const m of g.members) agentMemberClasses.add(m.className);
  for (let i = standaloneLeaves.length - 1; i >= 0; i--) {
    const base = standaloneLeaves[i].node.baseClass;
    if (base && agentMemberClasses.has(base)) standaloneLeaves.splice(i, 1);
  }

  // ── Build column-based layout ──
  interface LayoutBlock {
    type: 'agent-group' | 'dut' | 'standalone' | 'sequence-group';
    stage: number;
    w: number; h: number;
    data: any;
  }
  const layoutBlocks: LayoutBlock[] = [];

  // Agent groups — members arranged horizontally within rows
  for (const g of agentGroups) {
    const { row1, row2 } = agentRows(g.members);
    const r1Sizes = row1.map(m => measureLeaf(m, connCounts));
    const r2Sizes = row2.map(m => measureLeaf(m, connCounts));
    const r1W = r1Sizes.reduce((s, sz) => s + sz.w + GAP_X, 0) - GAP_X;
    const r1H = Math.max(...r1Sizes.map(sz => sz.h));
    const r2W = r2Sizes.length > 0 ? r2Sizes.reduce((s, sz) => s + sz.w + GAP_X, 0) - GAP_X : 0;
    const r2H = r2Sizes.length > 0 ? Math.max(...r2Sizes.map(sz => sz.h)) : 0;
    const w = Math.max(BLOCK_MIN_W + 20, r1W, r2W) + AGENT_PAD * 2;
    const h = HEADER_H + r1H + (row2.length > 0 ? CHILD_GAP + r2H : 0) + AGENT_PAD * 2;
    const minStage = Math.min(...g.members.map(m => STAGE[m.uvmType] ?? 3));
    layoutBlocks.push({ type: 'agent-group', stage: minStage, w, h, data: g });
  }

  // DUTs
  for (const dut of duts) {
    const leftCount = connCounts.get(dut.moduleName + ':L') || 0;
    const rightCount = connCounts.get(dut.moduleName + ':R') || 0;
    const portH = Math.max(leftCount, rightCount, 1) * PORT_GAP + 2 * PORT_MARGIN;
    const dutH = Math.max(DUT_H, portH);
    layoutBlocks.push({ type: 'dut', stage: 3, w: DUT_W, h: dutH, data: dut });
  }

  // Sequences grouped vertically
  const seqLeaves = standaloneLeaves.filter(s => s.node.uvmType === 'sequence');
  const nonSeqLeaves = standaloneLeaves.filter(s => s.node.uvmType !== 'sequence');
  if (seqLeaves.length > 1) {
    const memberSizes = seqLeaves.map(s => measureLeaf(s.node, connCounts));
    const w = Math.max(BLOCK_MIN_W + 20, ...memberSizes.map(s => s.w)) + PAD * 2;
    const h = HEADER_H + memberSizes.reduce((s, m) => s + m.h + GAP_Y, 0) - GAP_Y + PAD * 2;
    layoutBlocks.push({ type: 'sequence-group', stage: 0, w, h, data: seqLeaves });
  } else {
    for (const s of seqLeaves) {
      const sz = measureLeaf(s.node, connCounts);
      layoutBlocks.push({ type: 'standalone', stage: 0, w: sz.w, h: sz.h, data: s });
    }
  }

  // Non-sequence standalones
  for (const s of nonSeqLeaves) {
    const sz = measureLeaf(s.node, connCounts);
    layoutBlocks.push({ type: 'standalone', stage: STAGE[s.node.uvmType] ?? 5, w: sz.w, h: sz.h, data: s });
  }

  layoutBlocks.sort((a, b) => a.stage - b.stage);

  // ── Column grid with routing channels & vertical stacking ──
  const envNode = roots.find(r => r.uvmType === 'test')?.children.find(c => c.uvmType === 'env') || roots.find(r => r.uvmType === 'env');
  const testNode = roots.find(r => r.uvmType === 'test');
  const envHeaderH = envNode ? HEADER_H : 0;
  const testHeaderH = testNode ? HEADER_H : 0;

  // Group blocks by stage for vertical stacking within columns
  const stageGroups = new Map<number, LayoutBlock[]>();
  for (const block of layoutBlocks) {
    const s = block.stage < 0 ? 3 : block.stage;
    if (!stageGroups.has(s)) stageGroups.set(s, []);
    stageGroups.get(s)!.push(block);
  }
  const sortedStages = [...stageGroups.keys()].sort((a, b) => a - b);

  const startX = snap(PAD + (testNode ? PAD : 0) + (envNode ? PAD : 0));
  const baseY = snap(PAD + testHeaderH + envHeaderH);

  const blockPositions: { block: LayoutBlock; x: number; y: number }[] = [];
  let curX = startX;

  for (let si = 0; si < sortedStages.length; si++) {
    const stage = sortedStages[si];
    const blocks = stageGroups.get(stage)!;
    const colW = Math.max(...blocks.map(b => b.w));

    let curY = baseY;
    for (const block of blocks) {
      blockPositions.push({ block, x: snap(curX + (colW - block.w) / 2), y: snap(curY) });
      curY = snap(curY + block.h + GAP_Y);
    }

    curX = snap(curX + colW);
    if (si < sortedStages.length - 1) curX = snap(curX + GAP_X + CHANNEL_MIN_W);
  }

  // Compute bounding box of all placed blocks
  const maxRightX = blockPositions.length > 0 ? Math.max(...blockPositions.map(bp => bp.x + bp.block.w)) : startX;
  const maxBottomY = blockPositions.length > 0 ? Math.max(...blockPositions.map(bp => bp.y + bp.block.h)) : baseY;

  // Draw container boxes
  const envX = PAD + (testNode ? PAD : 0);
  const envY = PAD + testHeaderH;
  const envW = maxRightX + PAD - envX;
  const envH = maxBottomY + PAD - envY;

  if (testNode) {
    drawContainerBox(rootG, testNode, PAD, PAD, envX - PAD + envW + PAD, envY - PAD + envH + PAD);
  }
  if (envNode) drawContainerBox(rootG, envNode, envX, envY, envW, envH);

  // Draw each layout block
  for (const { block, x, y } of blockPositions) {
    if (block.type === 'agent-group') {
      drawAgentGroup(rootG, block.data as AgentGroup, x, y, block.w, block.h, connCounts);
    } else if (block.type === 'dut') {
      drawDutBlock(rootG, block.data as DutInfo, x, y, block.w, block.h);
    } else if (block.type === 'sequence-group') {
      drawSequenceGroup(rootG, block.data as { node: UvmDiagramNode }[], x, y, block.w, block.h, connCounts);
    } else {
      drawLeafBlock(rootG, (block.data as { node: UvmDiagramNode }).node, x, y, connCounts);
    }
  }

  // Phase 2: Route and draw connections
  drawAllConnections(rootG, roots);

  drawLegendOverlay();
  resetView();
}

// ═══════════════════════════════════════════════════════════════
// ═ BLOCK DRAWING
// ═══════════════════════════════════════════════════════════════

function drawContainerBox(parent: SVGGElement, node: UvmDiagramNode, x: number, y: number, w: number, h: number): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', `df-block df-${node.uvmType}`);
  const theme = THEMES[node.uvmType] || THEMES.unknown;
  g.appendChild(attrs(el('rect'), { x: 0, y: 0, width: w, height: h, rx: 8, fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2, opacity: 0.6 }));
  const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
  lbl.textContent = node.className; g.appendChild(lbl);
  const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
  badge.textContent = `[${node.uvmType}]`; g.appendChild(badge);
  drawIcon(g, node.uvmType, w, theme.accent);
  g.addEventListener('dblclick', (e) => { e.stopPropagation(); vscode.postMessage({ command: 'openFile', filePath: node.filePath, line: node.line }); });
  parent.appendChild(g);
  drawnContainers.push({ x, y, w, h });
}

function drawAgentGroup(parent: SVGGElement, group: AgentGroup, x: number, y: number, w: number, h: number, connCounts: Map<string, number>): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  if (group.agent) {
    const theme = THEMES.agent;
    g.setAttribute('class', 'df-block df-agent');
    g.appendChild(attrs(el('rect'), { x: 0, y: 0, width: w, height: h, rx: 6, fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2 }));
    const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
    lbl.textContent = group.agent.className; g.appendChild(lbl);
    const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
    badge.textContent = '[agent]'; g.appendChild(badge);
    drawIcon(g, 'agent', w, theme.accent);
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); vscode.postMessage({ command: 'openFile', filePath: group.agent!.filePath, line: group.agent!.line }); });
  }
  // Arrange members horizontally: row1 = sequencer+driver, row2 = monitor etc.
  const { row1, row2 } = agentRows(group.members);
  const r1Sizes = row1.map(m => measureLeaf(m, connCounts));
  const r1H = Math.max(...r1Sizes.map(sz => sz.h));

  let rx = AGENT_PAD;
  const r1Y = HEADER_H;
  for (let i = 0; i < row1.length; i++) {
    drawLeafBlock(g, row1[i], rx, r1Y + (r1H - r1Sizes[i].h) / 2, connCounts);
    rx += r1Sizes[i].w + GAP_X;
  }

  if (row2.length > 0) {
    const r2Sizes = row2.map(m => measureLeaf(m, connCounts));
    rx = AGENT_PAD;
    const r2Y = HEADER_H + r1H + CHILD_GAP;
    for (let i = 0; i < row2.length; i++) {
      drawLeafBlock(g, row2[i], rx, r2Y + 0, connCounts);
      rx += r2Sizes[i].w + GAP_X;
    }
  }

  parent.appendChild(g);
  const abs = absPos(g);
  if (group.agent) {
    drawnBlocks.push({ x: abs.x, y: abs.y, w, h, node: group.agent, kind: 'uvm', stage: -1 });
    drawnContainers.push({ x: abs.x, y: abs.y, w, h });
  }
}

function drawSequenceGroup(parent: SVGGElement, seqs: { node: UvmDiagramNode }[], x: number, y: number, w: number, h: number, connCounts: Map<string, number>): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', 'df-block');
  g.appendChild(attrs(el('rect'), { x: 0, y: 0, width: w, height: h, rx: 6, fill: '#0a1a1a', stroke: '#445', 'stroke-width': 1, 'stroke-dasharray': '4,2' }));
  let my = PAD;
  for (const s of seqs) {
    drawLeafBlock(g, s.node, PAD, my, connCounts);
    my += measureLeaf(s.node, connCounts).h + GAP_Y;
  }
  parent.appendChild(g);
}

function drawLeafBlock(parent: SVGGElement, node: UvmDiagramNode, x: number, y: number, connCounts: Map<string, number>): void {
  const sz = measureLeaf(node, connCounts);
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', `df-block df-${node.uvmType}`);
  g.setAttribute('data-class', node.className);
  const theme = THEMES[node.uvmType] || THEMES.unknown;
  g.appendChild(attrs(el('rect'), { x: 0, y: 0, width: sz.w, height: sz.h, rx: 6, fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2 }));
  const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
  lbl.textContent = node.className; g.appendChild(lbl);
  const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
  badge.textContent = `[${node.uvmType}]`; g.appendChild(badge);
  drawIcon(g, node.uvmType, sz.w, theme.accent);
  drawPorts(g, node, sz.w, sz.h, theme);
  g.addEventListener('dblclick', (e) => { e.stopPropagation(); vscode.postMessage({ command: 'openFile', filePath: node.filePath, line: node.line }); });
  parent.appendChild(g);
  const abs = absPos(g);
  drawnBlocks.push({ x: abs.x, y: abs.y, w: sz.w, h: sz.h, node, kind: 'uvm', stage: STAGE[node.uvmType] ?? 3 });
}

function drawDutBlock(parent: SVGGElement, dut: DutInfo, x: number, y: number, w: number, h: number): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', 'df-block df-dut');
  const theme = THEMES.dut;
  g.appendChild(attrs(el('rect'), { x: 0, y: 0, width: w, height: h, rx: 4, fill: theme.fill, stroke: theme.stroke, 'stroke-width': 3 }));
  g.appendChild(attrs(el('rect'), { x: 4, y: 4, width: w - 8, height: h - 8, rx: 3, fill: 'none', stroke: theme.stroke, 'stroke-width': 1, opacity: 0.4 }));
  const textBaseY = h / 2 - 14;
  const lbl = attrs(el('text'), { x: w / 2, y: textBaseY, 'text-anchor': 'middle', class: 'df-label' }) as SVGTextElement;
  lbl.textContent = dut.moduleName; g.appendChild(lbl);
  const badge2 = attrs(el('text'), { x: w / 2, y: textBaseY + 16, 'text-anchor': 'middle', class: 'df-type', fill: theme.accent }) as SVGTextElement;
  badge2.textContent = '[DUT]'; g.appendChild(badge2);
  if (dut.instanceName) {
    const inst = attrs(el('text'), { x: w / 2, y: textBaseY + 32, 'text-anchor': 'middle', 'font-size': 9, fill: '#999' }) as SVGTextElement;
    inst.textContent = `inst: ${dut.instanceName}`; g.appendChild(inst);
  }
  drawIcon(g, 'dut', w, theme.accent);
  g.addEventListener('dblclick', (e) => { e.stopPropagation(); vscode.postMessage({ command: 'openFile', filePath: dut.filePath, line: dut.line }); });
  parent.appendChild(g);
  const dutNode: UvmDiagramNode = { className: dut.moduleName, uvmType: 'dut', baseClass: '', filePath: dut.filePath, line: dut.line, children: [], fields: [], tlmPorts: [], connections: [], virtualIfs: [] };
  const abs = absPos(g);
  drawnBlocks.push({ x: abs.x, y: abs.y, w, h, node: dutNode, kind: 'dut', stage: 3 });
}

function drawPorts(g: SVGGElement, node: UvmDiagramNode, w: number, h: number, theme: Theme): void {
  if (node.tlmPorts.length === 0) return;
  const rightPorts = node.tlmPorts.filter(p => isOutputPort(p.kind));
  const leftPorts = node.tlmPorts.filter(p => !isOutputPort(p.kind));

  const drawSidePorts = (ports: TlmPort[], side: 'left' | 'right') => {
    if (ports.length === 0) return;
    const x = side === 'right' ? w : 0;
    const totalH = ports.length * PORT_GAP;
    let py = (h - totalH) / 2 + PORT_GAP / 2;
    const anchor = side === 'right' ? 'start' : 'end';
    const lblX = side === 'right' ? x + PORT_R + 4 : x - PORT_R - 4;
    for (const port of ports) {
      const isExp = port.kind.includes('export') || port.kind.includes('imp');
      const title = el('title') as SVGTitleElement;
      title.textContent = `${port.fieldName}: ${port.kind} #(${port.paramType})`;
      if (isExp) {
        const sq = attrs(el('rect'), { x: x - PORT_R, y: py - PORT_R, width: PORT_R * 2, height: PORT_R * 2, rx: 1, fill: theme.accent, stroke: '#fff', 'stroke-width': 0.8 });
        sq.appendChild(title); g.appendChild(sq);
      } else {
        const c = attrs(el('circle'), { cx: x, cy: py, r: PORT_R, fill: theme.accent, stroke: '#fff', 'stroke-width': 0.8 });
        c.appendChild(title); g.appendChild(c);
      }
      const lbl = attrs(el('text'), { x: lblX, y: py + 3, 'text-anchor': anchor, 'font-size': 7, fill: '#999', class: 'df-port-label' }) as SVGTextElement;
      lbl.textContent = port.fieldName.length > 10 ? port.fieldName.slice(0, 9) + '..' : port.fieldName;
      g.appendChild(lbl);
      py += PORT_GAP;
    }
  };
  drawSidePorts(leftPorts, 'left');
  drawSidePorts(rightPorts, 'right');
}

// ═══════════════════════════════════════════════════════════════
// ═ PHASE 2: ROUTING
// ═══════════════════════════════════════════════════════════════

function drawAllConnections(parent: SVGGElement, roots: UvmDiagramNode[]): void {
  const arrows: Arrow[] = [];

  // 1. Explicit TLM connections from connect_phase
  const processConns = (node: UvmDiagramNode) => {
    for (const conn of node.connections) {
      const fromParts = conn.from.split('.');
      const toParts = conn.to.split('.');
      const srcClass = resolveFieldToClass(node, fromParts[0]);
      const dstClass = resolveFieldToClass(node, toParts[0]);
      if (!srcClass || !dstClass) continue;
      const srcBlock = findBlockByClass(srcClass);
      const dstBlock = findBlockByClass(dstClass);
      if (!srcBlock || !dstBlock || srcBlock === dstBlock) continue;

      const portName = fromParts.length > 1 ? fromParts[fromParts.length - 1] : '';
      const isSeqItem = portName.includes('seq_item') || conn.to.includes('seq_item');
      const isAnalysis = portName.includes('analysis') || conn.to.includes('analysis') || portName.includes('_ap') || conn.to.includes('_fifo');

      let label: string, color: string, marker: string;
      if (isSeqItem) { label = 'seq_item_port'; color = '#c586c0'; marker = 'ah-seq'; }
      else if (isAnalysis) { label = 'analysis_port'; color = '#d16969'; marker = 'ah-ap'; }
      else { label = portName.length > 18 ? portName.slice(0, 16) + '..' : (portName || 'connect'); color = '#8888cc'; marker = 'ah'; }

      arrows.push({ from: srcBlock, to: dstBlock, label, color, marker, dashed: false, filePath: node.filePath, line: conn.line });
    }
    for (const ch of node.children) processConns(ch);
  };
  for (const r of roots) processConns(r);

  // 2. Infer driver ↔ sequencer within agents
  const inferAgent = (node: UvmDiagramNode) => {
    if (node.uvmType === 'agent') {
      const drv = node.children.find(c => c.uvmType === 'driver');
      const seqr = node.children.find(c => c.uvmType === 'sequencer');
      if (drv && seqr) {
        const drvB = findBlockByClass(drv.className);
        const seqrB = findBlockByClass(seqr.className);
        if (drvB && seqrB && !arrows.some(a => (a.from === drvB && a.to === seqrB) || (a.from === seqrB && a.to === drvB)))
          arrows.push({ from: seqrB, to: drvB, label: 'seq_item_port', color: '#c586c0', marker: 'ah-seq', dashed: false, filePath: drv.filePath, line: drv.line });
      }
    }
    for (const ch of node.children) inferAgent(ch);
  };
  for (const r of roots) inferAgent(r);

  // 3. Driver → DUT and DUT → Monitor
  const dutBlocks = drawnBlocks.filter(b => b.kind === 'dut');
  if (dutBlocks.length > 0) {
    const components: { block: BlockRect; node: UvmDiagramNode; parentAgent?: UvmDiagramNode }[] = [];
    const collect = (n: UvmDiagramNode, agent?: UvmDiagramNode) => {
      if (n.uvmType === 'driver' || n.uvmType === 'monitor') {
        const b = findBlockByClass(n.className);
        if (b) components.push({ block: b, node: n, parentAgent: agent });
      }
      for (const ch of n.children) collect(ch, n.uvmType === 'agent' ? n : agent);
    };
    for (const r of roots) collect(r);

    for (const comp of components) {
      let vif = '';
      if (comp.node.virtualIfs.length > 0) vif = comp.node.virtualIfs[0];
      else if (comp.parentAgent) { for (const ch of comp.parentAgent.children) { if (ch.virtualIfs.length > 0) { vif = ch.virtualIfs[0]; break; } } }
      const label = vif || 'vif';
      const dut = dutBlocks.length === 1 ? dutBlocks[0] : nearest(comp.block, dutBlocks);
      if (comp.node.uvmType === 'driver')
        arrows.push({ from: comp.block, to: dut, label, color: '#e6b422', marker: 'ah-dut', dashed: true, filePath: comp.node.filePath, line: comp.node.line });
      else
        arrows.push({ from: dut, to: comp.block, label, color: '#e6b422', marker: 'ah-dut', dashed: true, filePath: comp.node.filePath, line: comp.node.line });
    }
  }

  // 4. Monitor/Agent → Scoreboard
  const sbBlocks = drawnBlocks.filter(b => b.node.uvmType === 'scoreboard');
  const agentBlocks = drawnBlocks.filter(b => b.node.uvmType === 'agent');
  for (const sb of sbBlocks) {
    if (!arrows.some(a => a.to === sb)) {
      for (const ag of agentBlocks) {
        if (ag.node.tlmPorts.some(p => p.kind.includes('analysis')))
          arrows.push({ from: ag, to: sb, label: 'analysis_port', color: '#d16969', marker: 'ah-ap', dashed: false, filePath: ag.node.filePath, line: ag.node.line });
      }
      if (!arrows.some(a => a.to === sb)) {
        const monBlocks = drawnBlocks.filter(b => b.node.uvmType === 'monitor' && b.node.tlmPorts.some(p => p.kind.includes('analysis')));
        for (const mon of monBlocks)
          arrows.push({ from: mon, to: sb, label: 'analysis_port', color: '#d16969', marker: 'ah-ap', dashed: false, filePath: mon.node.filePath, line: mon.node.line });
      }
    }
  }

  if (arrows.length === 0) return;

  const cg = el('g') as SVGGElement;
  cg.setAttribute('class', 'df-connections');
  routeAndDrawArrows(cg, arrows);
  parent.appendChild(cg);
}

function nearest(block: BlockRect, targets: BlockRect[]): BlockRect {
  let best = targets[0]; let minD = Infinity;
  const cx = block.x + block.w / 2, cy = block.y + block.h / 2;
  for (const t of targets) {
    const d = (t.x + t.w / 2 - cx) ** 2 + (t.y + t.h / 2 - cy) ** 2;
    if (d < minD) { minD = d; best = t; }
  }
  return best;
}

// ─── Grid-based orthogonal router (A*) ────────────────────────

interface OccGrid {
  cols: number; rows: number;
  data: Uint8Array;
  ox: number; oy: number;
}

function buildOccGrid(): OccGrid {
  if (drawnBlocks.length === 0)
    return { cols: 1, rows: 1, data: new Uint8Array(1), ox: 0, oy: 0 };
  const BORDER = 8;
  let minPx = Infinity, minPy = Infinity, maxPx = -Infinity, maxPy = -Infinity;
  for (const b of drawnBlocks) {
    if (b.x < minPx) minPx = b.x;
    if (b.y < minPy) minPy = b.y;
    if (b.x + b.w > maxPx) maxPx = b.x + b.w;
    if (b.y + b.h > maxPy) maxPy = b.y + b.h;
  }
  const ox = snap(minPx) - BORDER * GRID;
  const oy = snap(minPy) - BORDER * GRID;
  const cols = Math.min(500, Math.ceil((maxPx - ox) / GRID) + BORDER * 2);
  const rows = Math.min(500, Math.ceil((maxPy - oy) / GRID) + BORDER * 2);
  const data = new Uint8Array(rows * cols);
  const gMark = (gc: number, gr: number) => {
    if (gc >= 0 && gc < cols && gr >= 0 && gr < rows) data[gr * cols + gc] = 1;
  };

  // Mark solid blocks (stage >= 0) as impassable — skip containers
  for (const b of drawnBlocks) {
    if (b.stage < 0) continue;
    const c0 = Math.floor((b.x - ox) / GRID) - ROUTE_MARGIN;
    const c1 = Math.ceil((b.x + b.w - ox) / GRID) + ROUTE_MARGIN;
    const r0 = Math.floor((b.y - oy) / GRID) - ROUTE_MARGIN;
    const r1 = Math.ceil((b.y + b.h - oy) / GRID) + ROUTE_MARGIN;
    for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++)
      for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++)
        data[r * cols + c] = 1;
  }

  // Mark container borders (agents, envs) so connections avoid them
  for (const ct of drawnContainers) {
    const cL = Math.round((ct.x - ox) / GRID);
    const cR = Math.round((ct.x + ct.w - ox) / GRID);
    const rT = Math.round((ct.y - oy) / GRID);
    const rB = Math.round((ct.y + ct.h - oy) / GRID);
    // Top & bottom edges
    for (let c = cL; c <= cR; c++) {
      for (let dr = -1; dr <= 1; dr++) { gMark(c, rT + dr); gMark(c, rB + dr); }
    }
    // Left & right edges
    for (let r = rT; r <= rB; r++) {
      for (let dc = -1; dc <= 1; dc++) { gMark(cL + dc, r); gMark(cR + dc, r); }
    }
  }

  return { cols, rows, data, ox, oy };
}

function gridRoute(
  sx: number, sy: number, tx: number, ty: number, grid: OccGrid, firstRight = false
): Pt[] {
  const { cols, rows, data } = grid;
  const clamp = (v: number, mx: number) => Math.max(0, Math.min(mx - 1, v));
  const sc = clamp(Math.round((sx - grid.ox) / GRID), cols);
  const sr = clamp(Math.round((sy - grid.oy) / GRID), rows);
  const tc = clamp(Math.round((tx - grid.ox) / GRID), cols);
  const tr = clamp(Math.round((ty - grid.oy) / GRID), rows);
  if (sc === tc && sr === tr)
    return [{ x: sx, y: sy }, { x: tx, y: ty }];

  const DC = [1, 0, -1, 0], DR = [0, 1, 0, -1];
  const TURN_COST = 3;
  const stateCount = rows * cols * 4;
  const dist = new Float32Array(stateCount).fill(Infinity);
  const prev = new Int32Array(stateCount).fill(-1);
  const idx = (c: number, r: number, d: number) => (r * cols + c) * 4 + d;
  const heur = (c: number, r: number) => Math.abs(c - tc) + Math.abs(r - tr);

  // Min-heap of [fScore, stateIdx]
  const heap: [number, number][] = [];
  const hpush = (f: number, si: number) => {
    heap.push([f, si]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const hpop = (): [number, number] | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        let s = i; const l = 2 * i + 1, ri = 2 * i + 2;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (ri < heap.length && heap[ri][0] < heap[s][0]) s = ri;
        if (s === i) break; [heap[i], heap[s]] = [heap[s], heap[i]]; i = s;
      }
    }
    return top;
  };

  // Seed directions from start (firstRight: only direction 0 = right)
  for (let d = 0; d < 4; d++) dist[idx(sc, sr, d)] = 0;
  const seedDirs = firstRight ? [0] : [0, 1, 2, 3];
  for (const d of seedDirs) {
    const nc = sc + DC[d], nr = sr + DR[d];
    if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
    if (data[nr * cols + nc] !== 0) continue;
    const si = idx(nc, nr, d);
    dist[si] = 1; prev[si] = idx(sc, sr, d);
    hpush(1 + heur(nc, nr), si);
  }

  let found = -1, iters = 0;
  const maxIters = Math.min(stateCount, 200000);
  while (heap.length && iters++ < maxIters) {
    const [, si] = hpop()!;
    const d = si & 3, ci = si >> 2, c = ci % cols, r = (ci - c) / cols;
    const g = dist[si];
    if (c === tc && r === tr) { found = si; break; }
    for (let nd = 0; nd < 4; nd++) {
      const nc = c + DC[nd], nr = r + DR[nd];
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || data[nr * cols + nc]) continue;
      const ng = g + 1 + (nd !== d ? TURN_COST : 0);
      const nsi = idx(nc, nr, nd);
      if (ng < dist[nsi]) { dist[nsi] = ng; prev[nsi] = si; hpush(ng + heur(nc, nr), nsi); }
    }
  }

  if (found < 0) {
    // Fallback: route above all blocks via perimeter (never through them)
    const topY = grid.oy + GRID;
    const exitX = snap(sx + STUB_LEN);
    const entryX = snap(tx - STUB_LEN);
    return [
      { x: sx, y: sy }, { x: exitX, y: sy },
      { x: exitX, y: topY }, { x: entryX, y: topY },
      { x: entryX, y: ty }, { x: tx, y: ty },
    ];
  }

  // Reconstruct grid path
  const gp: [number, number][] = [];
  let cur = found;
  while (cur >= 0) {
    const ci = cur >> 2, c = ci % cols, r = (ci - c) / cols;
    gp.push([c, r]);
    if (c === sc && r === sr) break;
    cur = prev[cur];
  }
  gp.reverse();

  // Collapse collinear cells into waypoints
  const pts: Pt[] = [];
  for (const [c, r] of gp) {
    const px = c * GRID + grid.ox, py = r * GRID + grid.oy;
    const n = pts.length;
    if (n >= 2) {
      const p1 = pts[n - 1], p2 = pts[n - 2];
      if ((Math.abs(p1.x - px) < 1 && Math.abs(p2.x - px) < 1) ||
          (Math.abs(p1.y - py) < 1 && Math.abs(p2.y - py) < 1)) {
        p1.x = px; p1.y = py; continue;
      }
    }
    pts.push({ x: px, y: py });
  }
  if (pts.length >= 1) {
    pts[0] = { x: sx, y: sy };
    pts[pts.length - 1] = { x: tx, y: ty };
  }
  return pts;
}

function markPathOnGrid(waypoints: Pt[], grid: OccGrid): void {
  const { cols, rows, data } = grid;
  const mark = (mc: number, mr: number) => {
    if (mc >= 0 && mc < cols && mr >= 0 && mr < rows) data[mr * cols + mc] = 1;
  };
  for (let i = 0; i < waypoints.length - 1; i++) {
    const c0 = Math.round((waypoints[i].x - grid.ox) / GRID);
    const r0 = Math.round((waypoints[i].y - grid.oy) / GRID);
    const c1 = Math.round((waypoints[i + 1].x - grid.ox) / GRID);
    const r1 = Math.round((waypoints[i + 1].y - grid.oy) / GRID);
    if (Math.abs(c0 - c1) < 1) {
      // Vertical segment — mark column ± 1 for clearance
      const c = c0, rMin = Math.min(r0, r1), rMax = Math.max(r0, r1);
      for (let r = rMin; r <= rMax; r++)
        for (let dc = -1; dc <= 1; dc++) mark(c + dc, r);
    } else {
      // Horizontal segment — mark row ± 1 for clearance
      const r = r0, cMin = Math.min(c0, c1), cMax = Math.max(c0, c1);
      for (let c = cMin; c <= cMax; c++)
        for (let dr = -1; dr <= 1; dr++) mark(c, r + dr);
    }
  }
}

interface RoutedArrow {
  arrow: Arrow;
  srcX: number; srcY: number;
  tgtX: number; tgtY: number;
  waypoints: Pt[];
}

function routeAndDrawArrows(parent: SVGGElement, arrows: Arrow[]): void {
  const routed: RoutedArrow[] = arrows.map(a =>
    ({ arrow: a, srcX: 0, srcY: 0, tgtX: 0, tgtY: 0, waypoints: [] }));

  // Assign port slots — exit RIGHT, enter LEFT
  const srcSlotMap = new Map<string, RoutedArrow[]>();
  const tgtSlotMap = new Map<string, RoutedArrow[]>();
  for (const ra of routed) {
    const sk = ra.arrow.from.node.className, tk = ra.arrow.to.node.className;
    if (!srcSlotMap.has(sk)) srcSlotMap.set(sk, []);
    srcSlotMap.get(sk)!.push(ra);
    if (!tgtSlotMap.has(tk)) tgtSlotMap.set(tk, []);
    tgtSlotMap.get(tk)!.push(ra);
  }

  for (const [, ras] of srcSlotMap) {
    const block = ras[0].arrow.from;
    ras.sort((a, b) => (a.arrow.to.y + a.arrow.to.h / 2) - (b.arrow.to.y + b.arrow.to.h / 2));
    const count = ras.length, span = (count - 1) * PORT_GAP;
    const baseY = block.y + (block.h - span) / 2;
    for (let i = 0; i < count; i++) {
      ras[i].srcX = snap(block.x + block.w);
      ras[i].srcY = snap(count === 1 ? block.y + block.h / 2 : baseY + i * PORT_GAP);
    }
  }

  for (const [, ras] of tgtSlotMap) {
    const block = ras[0].arrow.to;
    ras.sort((a, b) => (a.arrow.from.y + a.arrow.from.h / 2) - (b.arrow.from.y + b.arrow.from.h / 2));
    const count = ras.length, span = (count - 1) * PORT_GAP;
    const baseY = block.y + (block.h - span) / 2;
    for (let i = 0; i < count; i++) {
      ras[i].tgtX = snap(block.x);
      ras[i].tgtY = snap(count === 1 ? block.y + block.h / 2 : baseY + i * PORT_GAP);
    }
  }

  // Build occupancy grid
  const grid = buildOccGrid();

  // Route shorter connections first to minimize crossings
  const sorted = [...routed].sort((a, b) =>
    (Math.abs(a.srcX - a.tgtX) + Math.abs(a.srcY - a.tgtY)) -
    (Math.abs(b.srcX - b.tgtX) + Math.abs(b.srcY - b.tgtY)));

  const CORRIDOR_LEN = Math.ceil(STUB_LEN / GRID) + ROUTE_MARGIN + 3;

  for (const ra of sorted) {
    const savedIdxs: number[] = [];
    const savedVals: number[] = [];
    const clearCell = (gc: number, gr: number) => {
      if (gc >= 0 && gc < grid.cols && gr >= 0 && gr < grid.rows) {
        const gi = gr * grid.cols + gc;
        if (grid.data[gi]) { savedIdxs.push(gi); savedVals.push(grid.data[gi]); grid.data[gi] = 0; }
      }
    };

    // Unblock source and target blocks + margins
    for (const blk of [ra.arrow.from, ra.arrow.to]) {
      const c0 = Math.floor((blk.x - grid.ox) / GRID) - ROUTE_MARGIN;
      const c1 = Math.ceil((blk.x + blk.w - grid.ox) / GRID) + ROUTE_MARGIN;
      const r0 = Math.floor((blk.y - grid.oy) / GRID) - ROUTE_MARGIN;
      const r1 = Math.ceil((blk.y + blk.h - grid.oy) / GRID) + ROUTE_MARGIN;
      for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r++)
        for (let c = Math.max(0, c0); c <= Math.min(grid.cols - 1, c1); c++)
          clearCell(c, r);
    }

    // Clear rightward corridor from source port (cuts through container borders)
    const srcCol = Math.round((ra.srcX - grid.ox) / GRID);
    const srcRow = Math.round((ra.srcY - grid.oy) / GRID);
    for (let c = srcCol; c <= srcCol + CORRIDOR_LEN; c++) clearCell(c, srcRow);

    // Clear leftward corridor into target port
    const tgtCol = Math.round((ra.tgtX - grid.ox) / GRID);
    const tgtRow = Math.round((ra.tgtY - grid.oy) / GRID);
    for (let c = tgtCol; c >= tgtCol - CORRIDOR_LEN; c--) clearCell(c, tgtRow);

    // Route A* between stub endpoints — stubs guarantee arrowheads point right
    const stubSX = snap(ra.srcX + STUB_LEN);
    const stubTX = snap(ra.tgtX - STUB_LEN);
    const path = gridRoute(stubSX, ra.srcY, stubTX, ra.tgtY, grid, true);

    // Restore cleared cells
    for (let i = 0; i < savedIdxs.length; i++) grid.data[savedIdxs[i]] = savedVals[i];

    // Compose: src port → stub → A* path → stub → tgt port
    const wp: Pt[] = [{ x: ra.srcX, y: ra.srcY }];
    for (const p of path) {
      const last = wp[wp.length - 1];
      if (Math.abs(last.x - p.x) > 1 || Math.abs(last.y - p.y) > 1) wp.push(p);
    }
    const tgt = { x: ra.tgtX, y: ra.tgtY };
    if (Math.abs(wp[wp.length - 1].x - tgt.x) > 1 || Math.abs(wp[wp.length - 1].y - tgt.y) > 1)
      wp.push(tgt);
    ra.waypoints = wp;
    markPathOnGrid(wp, grid);
  }

  // Draw all arrows and junctions
  for (const ra of routed) drawArrow(parent, ra);
  drawJunctions(parent, routed);
}

// ═══════════════════════════════════════════════════════════════
// ═ PHASE 3: DRAWING
// ═══════════════════════════════════════════════════════════════

function drawArrow(parent: SVGGElement, ra: RoutedArrow): void {
  const { arrow: a, waypoints: pts } = ra;
  if (pts.length < 2) return;

  // Enforce strict orthogonality by inserting corners for any diagonal segments
  {
    const clean: Pt[] = [{ x: pts[0].x, y: pts[0].y }];
    for (let i = 1; i < pts.length; i++) {
      const prev = clean[clean.length - 1];
      const cur = pts[i];
      if (Math.abs(prev.x - cur.x) > 1 && Math.abs(prev.y - cur.y) > 1) {
        clean.push({ x: cur.x, y: prev.y });
      }
      clean.push({ x: cur.x, y: cur.y });
    }
    const final: Pt[] = [clean[0]];
    for (let i = 1; i < clean.length - 1; i++) {
      const p = final[final.length - 1], c = clean[i], n = clean[i + 1];
      if (!(Math.abs(p.x - c.x) < 1 && Math.abs(c.x - n.x) < 1) &&
          !(Math.abs(p.y - c.y) < 1 && Math.abs(c.y - n.y) < 1)) final.push(c);
    }
    final.push(clean[clean.length - 1]);
    pts.length = 0;
    pts.push(...final);
  }

  // Ensure last segment is long enough for arrowhead
  if (pts.length >= 3) {
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const dx = last.x - prev.x, dy = last.y - prev.y;
    const segLen = Math.abs(dx) + Math.abs(dy);
    if (segLen > 0 && segLen < 14) {
      if (Math.abs(dx) > Math.abs(dy)) prev.x = last.x - Math.sign(dx) * 14;
      else prev.y = last.y - Math.sign(dy) * 14;
    }
  }

  // Wrap entire arrow in a group for unified hover
  const ag = el('g') as SVGGElement;
  ag.setAttribute('class', 'df-arrow-group');

  // Port circles
  ag.appendChild(attrs(el('circle'), { cx: pts[0].x, cy: pts[0].y, r: PORT_CIRCLE_R, fill: a.color, stroke: '#1e1e1e', 'stroke-width': 1, class: 'df-port-dot' }));
  ag.appendChild(attrs(el('circle'), { cx: pts[pts.length - 1].x, cy: pts[pts.length - 1].y, r: PORT_CIRCLE_R, fill: a.color, stroke: '#1e1e1e', 'stroke-width': 1, class: 'df-port-dot' }));

  // Build strictly-orthogonal SVG path (M + L only)
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) d += ` L${pts[i].x},${pts[i].y}`;

  const arrowPath = attrs(el('path'), {
    d, class: 'df-arrow',
    stroke: a.color, 'stroke-width': 1.8, fill: 'none',
    'stroke-dasharray': a.dashed ? '6,3' : 'none',
    'marker-end': `url(#${a.marker})`,
  });

  if (a.filePath && a.line) {
    arrowPath.style.cursor = 'pointer';
    const title = el('title') as SVGTitleElement;
    title.textContent = `Click to open connection (line ${a.line})`;
    arrowPath.appendChild(title);
    arrowPath.addEventListener('dblclick', () => { vscode.postMessage({ command: 'openFile', filePath: a.filePath, line: a.line }); });
  }
  ag.appendChild(arrowPath);

  // Label on longest segment (with collision avoidance)
  if (a.label) {
    const displayLabel = a.label.length > 20 ? a.label.slice(0, 18) + '..' : a.label;
    const tw = displayLabel.length * 5 + 10;
    const th = 14;

    // Collect segments sorted by length (longest first)
    const segs: { mx: number; my: number; len: number; isVert: boolean }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const sdx = pts[i + 1].x - pts[i].x, sdy = pts[i + 1].y - pts[i].y;
      const len = Math.abs(sdx) + Math.abs(sdy);
      if (len > 10) segs.push({ mx: (pts[i].x + pts[i + 1].x) / 2, my: (pts[i].y + pts[i + 1].y) / 2, len, isVert: Math.abs(sdy) > Math.abs(sdx) });
    }
    segs.sort((s1, s2) => s2.len - s1.len);

    const lblOverlaps = (lLeft: number, lTop: number) => {
      const lRight = lLeft + tw, lBot = lTop + th;
      const hit = (bx: number, by: number, bw: number, bh: number) =>
        lLeft < bx + bw + 4 && lRight > bx - 4 && lTop < by + bh + 4 && lBot > by - 4;
      return drawnBlocks.some(b => b.stage >= 0 && hit(b.x, b.y, b.w, b.h)) ||
             drawnContainers.some(c => hit(c.x, c.y, c.w, c.h)) ||
             drawnLabels.some(l => hit(l.x, l.y, l.w, l.h));
    };

    let lx = 0, ly = 0, placed = false;
    for (const seg of segs) {
      const cx = seg.isVert ? seg.mx + tw / 2 + 6 : seg.mx;
      const cy = seg.isVert ? seg.my : seg.my - 12;
      if (!lblOverlaps(cx - tw / 2, cy - th / 2)) { lx = cx; ly = cy; placed = true; break; }
    }
    // Try offset positions if primary placements overlap
    if (!placed) {
      for (const seg of segs) {
        for (const [ox, oy] of [[0, -th - 6], [0, th + 6], [tw, 0], [-tw, 0]]) {
          const cx = (seg.isVert ? seg.mx + tw / 2 + 6 : seg.mx) + ox;
          const cy = (seg.isVert ? seg.my : seg.my - 12) + oy;
          if (!lblOverlaps(cx - tw / 2, cy - th / 2)) { lx = cx; ly = cy; placed = true; break; }
        }
        if (placed) break;
      }
    }
    if (!placed && segs.length > 0) {
      const seg = segs[0];
      lx = seg.isVert ? seg.mx + tw / 2 + 8 : seg.mx;
      ly = seg.isVert ? seg.my : seg.my - th - 4;
    }
    if (segs.length > 0) {
      drawnLabels.push({ x: lx - tw / 2, y: ly - th / 2, w: tw, h: th });
      ag.appendChild(attrs(el('rect'), { x: lx - tw / 2, y: ly - 7, width: tw, height: th, rx: 3, fill: '#111', opacity: 0.92, stroke: a.color, 'stroke-width': 0.5, class: 'df-label-bg' }));
      const lbl = attrs(el('text'), { x: lx, y: ly + 3, 'text-anchor': 'middle', 'font-size': 8, fill: a.color, class: 'df-arrow-label' }) as SVGTextElement;
      lbl.textContent = displayLabel;
      ag.appendChild(lbl);
    }
  }
  parent.appendChild(ag);
}

function drawJunctions(parent: SVGGElement, routed: RoutedArrow[]): void {
  // Find connection points where multiple arrows share the same exit/entry
  const pointMap = new Map<string, { x: number; y: number; color: string; count: number }>();
  for (const ra of routed) {
    const pts = ra.waypoints;
    if (pts.length < 2) continue;
    for (const pt of [pts[0], pts[pts.length - 1]]) {
      const k = `${Math.round(pt.x)},${Math.round(pt.y)}`;
      if (pointMap.has(k)) pointMap.get(k)!.count++;
      else pointMap.set(k, { x: pt.x, y: pt.y, color: ra.arrow.color, count: 1 });
    }
  }
  for (const [, pt] of pointMap) {
    if (pt.count <= 1) continue;
    const jw = 8, jh = Math.min(pt.count * 8, 24);
    parent.appendChild(attrs(el('rect'), {
      x: pt.x - jw / 2, y: pt.y - jh / 2, width: jw, height: jh,
      rx: jw / 2, fill: pt.color, opacity: 0.5, class: 'df-port-dot',
    }));
  }
}

// ─── Symbolic icons ───────────────────────────────────────────
function drawIcon(g: SVGGElement, type: string, w: number, color: string): void {
  const ix = w - 22, iy = 6;
  const ig = el('g') as SVGGElement;
  ig.setAttribute('transform', `translate(${ix},${iy})`);
  ig.setAttribute('class', 'df-icon');
  const s = (tag: string, a: Record<string, string | number>): SVGElement =>
    attrs(el(tag), { ...a, stroke: color, fill: 'none', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });

  switch (type) {
    case 'test':
      ig.appendChild(s('path', { d: 'M5,1 h4 M6,1 v3.5 L3,10.5 a1.5,1.5,0,0,0,1.3,2.2 h5.4 a1.5,1.5,0,0,0,1.3-2.2 L8,4.5 v-3.5' }));
      ig.appendChild(s('polyline', { points: '5.5,10 6.5,11 8.5,9' }));
      break;
    case 'env':
      ig.appendChild(s('path', { d: 'M7,13 v-5 Q7,3 12,2 Q11,8 7,8' }));
      ig.appendChild(s('path', { d: 'M7,10 Q3,4 2,2 Q7,3 7,8' }));
      break;
    case 'agent':
      ig.appendChild(s('rect', { x: 1.5, y: 5, width: 11, height: 8, rx: 1.5 }));
      ig.appendChild(s('path', { d: 'M5,5 v-2 a1,1,0,0,1,1-1 h2 a1,1,0,0,1,1,1 v2' }));
      ig.appendChild(s('line', { x1: 1.5, y1: 9, x2: 12.5, y2: 9 }));
      break;
    case 'driver':
      ig.appendChild(s('path', { d: 'M2,4 h6 l-2,-2.5 M8,4 l-2,2.5' }));
      ig.appendChild(s('path', { d: 'M2,10 h6 l-2,-2.5 M8,10 l-2,2.5' }));
      ig.appendChild(attrs(el('line'), { x1: 10, y1: 2, x2: 10, y2: 12, stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
      break;
    case 'monitor':
      ig.appendChild(s('rect', { x: 1.5, y: 1.5, width: 11, height: 8, rx: 1.5 }));
      ig.appendChild(s('line', { x1: 7, y1: 9.5, x2: 7, y2: 12 }));
      ig.appendChild(s('line', { x1: 4, y1: 12, x2: 10, y2: 12 }));
      ig.appendChild(s('polyline', { points: '3.5,5.5 5,3.5 6.5,7 8,4 9.5,6.5 11,4.5' }));
      break;
    case 'sequencer':
      ig.appendChild(s('polyline', { points: '4,2 7,5 10,2' }));
      ig.appendChild(s('polyline', { points: '4,5.5 7,8.5 10,5.5' }));
      ig.appendChild(s('polyline', { points: '4,9 7,12 10,9' }));
      break;
    case 'scoreboard':
      ig.appendChild(s('line', { x1: 7, y1: 1.5, x2: 7, y2: 10 }));
      ig.appendChild(s('line', { x1: 3, y1: 3.5, x2: 11, y2: 3.5 }));
      ig.appendChild(s('path', { d: 'M3,3.5 L1.5,7.5 h3 z' }));
      ig.appendChild(s('path', { d: 'M11,3.5 L9.5,7.5 h3 z' }));
      ig.appendChild(s('polygon', { points: '5,12 9,12 7,10' }));
      (ig.lastChild as SVGElement).setAttribute('fill', color);
      (ig.lastChild as SVGElement).setAttribute('opacity', '0.3');
      break;
    case 'sequence':
      ig.appendChild(s('rect', { x: 3, y: 1, width: 9, height: 6, rx: 1 }));
      ig.appendChild(s('rect', { x: 1.5, y: 3.5, width: 9, height: 6, rx: 1 }));
      ig.appendChild(s('rect', { x: 0, y: 6, width: 9, height: 6, rx: 1 }));
      break;
    case 'component':
      ig.appendChild(s('rect', { x: 3.5, y: 2, width: 7, height: 10, rx: 1 }));
      ig.appendChild(s('line', { x1: 1, y1: 5, x2: 3.5, y2: 5 }));
      ig.appendChild(s('line', { x1: 1, y1: 9, x2: 3.5, y2: 9 }));
      ig.appendChild(s('line', { x1: 10.5, y1: 5, x2: 13, y2: 5 }));
      ig.appendChild(s('line', { x1: 10.5, y1: 9, x2: 13, y2: 9 }));
      break;
    case 'dut':
      ig.appendChild(s('rect', { x: 3, y: 2, width: 8, height: 10, rx: 1 }));
      ig.appendChild(s('line', { x1: 0, y1: 4, x2: 3, y2: 4 }));
      ig.appendChild(s('line', { x1: 0, y1: 7, x2: 3, y2: 7 }));
      ig.appendChild(s('line', { x1: 0, y1: 10, x2: 3, y2: 10 }));
      ig.appendChild(s('line', { x1: 11, y1: 4, x2: 14, y2: 4 }));
      ig.appendChild(s('line', { x1: 11, y1: 7, x2: 14, y2: 7 }));
      ig.appendChild(s('line', { x1: 11, y1: 10, x2: 14, y2: 10 }));
      ig.appendChild(s('line', { x1: 5, y1: 0, x2: 5, y2: 2 }));
      ig.appendChild(s('line', { x1: 9, y1: 0, x2: 9, y2: 2 }));
      break;
    case 'object':
      ig.appendChild(s('path', { d: 'M2,1.5 h6.5 l3,3 v8 a1,1,0,0,1-1,1 h-8.5 a1,1,0,0,1-1-1 v-10 a1,1,0,0,1,1-1 z' }));
      ig.appendChild(s('path', { d: 'M8.5,1.5 v3 h3' }));
      break;
    default:
      ig.appendChild(s('rect', { x: 2, y: 2, width: 10, height: 10, rx: 2 }));
      break;
  }
  g.appendChild(ig);
}

// ─── Legend ───────────────────────────────────────────────────
function legendIconHtml(type: string): string {
  const c = THEMES[type]?.stroke || '#888';
  const s = `stroke="${c}" fill="none" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"`;
  switch (type) {
    case 'test': return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M5,1 h4 M6,1 v3.5 L3,10.5 a1.5,1.5,0,0,0,1.3,2.2 h5.4 a1.5,1.5,0,0,0,1.3-2.2 L8,4.5 v-3.5"/><polyline ${s} points="5.5,10 6.5,11 8.5,9"/></svg>`;
    case 'env': return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M7,13 v-5 Q7,3 12,2 Q11,8 7,8"/><path ${s} d="M7,10 Q3,4 2,2 Q7,3 7,8"/></svg>`;
    case 'agent': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="1.5" y="5" width="11" height="8" rx="1.5"/><path ${s} d="M5,5 v-2 a1,1,0,0,1,1-1 h2 a1,1,0,0,1,1,1 v2"/><line ${s} x1="1.5" y1="9" x2="12.5" y2="9"/></svg>`;
    case 'driver': return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M2,4 h6 l-2,-2.5 M8,4 l-2,2.5"/><path ${s} d="M2,10 h6 l-2,-2.5 M8,10 l-2,2.5"/><line stroke="${c}" stroke-width="1.5" stroke-linecap="round" x1="10" y1="2" x2="10" y2="12"/></svg>`;
    case 'monitor': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="1.5" y="1.5" width="11" height="8" rx="1.5"/><line ${s} x1="7" y1="9.5" x2="7" y2="12"/><line ${s} x1="4" y1="12" x2="10" y2="12"/><polyline ${s} points="3.5,5.5 5,3.5 6.5,7 8,4 9.5,6.5 11,4.5"/></svg>`;
    case 'sequencer': return `<svg width="14" height="14" viewBox="0 0 14 14"><polyline ${s} points="4,2 7,5 10,2"/><polyline ${s} points="4,5.5 7,8.5 10,5.5"/><polyline ${s} points="4,9 7,12 10,9"/></svg>`;
    case 'scoreboard': return `<svg width="14" height="14" viewBox="0 0 14 14"><line ${s} x1="7" y1="1.5" x2="7" y2="10"/><line ${s} x1="3" y1="3.5" x2="11" y2="3.5"/><path ${s} d="M3,3.5 L1.5,7.5 h3 z"/><path ${s} d="M11,3.5 L9.5,7.5 h3 z"/><polygon points="5,12 9,12 7,10" stroke="${c}" fill="${c}" opacity="0.3" stroke-width="1.2"/></svg>`;
    case 'sequence': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="3" y="1" width="9" height="6" rx="1"/><rect ${s} x="1.5" y="3.5" width="9" height="6" rx="1"/><rect ${s} x="0" y="6" width="9" height="6" rx="1"/></svg>`;
    case 'component': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="3.5" y="2" width="7" height="10" rx="1"/><line ${s} x1="1" y1="5" x2="3.5" y2="5"/><line ${s} x1="1" y1="9" x2="3.5" y2="9"/><line ${s} x1="10.5" y1="5" x2="13" y2="5"/><line ${s} x1="10.5" y1="9" x2="13" y2="9"/></svg>`;
    case 'dut': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="3" y="2" width="8" height="10" rx="1"/><line ${s} x1="0" y1="4" x2="3" y2="4"/><line ${s} x1="0" y1="7" x2="3" y2="7"/><line ${s} x1="0" y1="10" x2="3" y2="10"/><line ${s} x1="11" y1="4" x2="14" y2="4"/><line ${s} x1="11" y1="7" x2="14" y2="7"/><line ${s} x1="11" y1="10" x2="14" y2="10"/><line ${s} x1="5" y1="0" x2="5" y2="2"/><line ${s} x1="9" y1="0" x2="9" y2="2"/></svg>`;
    case 'object': return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M2,1.5 h6.5 l3,3 v8 a1,1,0,0,1-1,1 h-8.5 a1,1,0,0,1-1-1 v-10 a1,1,0,0,1,1-1 z"/><path ${s} d="M8.5,1.5 v3 h3"/></svg>`;
    default: return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="2" y="2" width="10" height="10" rx="2"/></svg>`;
  }
}

function drawLegendOverlay(): void {
  const container = document.getElementById('legend-overlay');
  if (!container) return;
  const types = Object.keys(THEMES).filter(k => k !== 'unknown');
  const connTypes = [
    { label: 'TLM Connection', color: '#8888cc', dashed: false },
    { label: 'Seq Item Port', color: '#c586c0', dashed: false },
    { label: 'Virtual Interface', color: '#e6b422', dashed: true },
    { label: 'Analysis Port', color: '#d16969', dashed: false },
  ];
  let html = '<div class="legend-title">Legend</div>';
  for (const t of types) {
    const th = THEMES[t];
    html += `<div class="legend-item"><span class="legend-swatch" style="background:${th.fill};border:1.5px solid ${th.stroke};"></span><span class="legend-icon-svg">${legendIconHtml(t)}</span><span>${t}</span></div>`;
  }
  html += '<div class="legend-section-title">Connections</div>';
  for (const c of connTypes) {
    const dashAttr = c.dashed ? ' stroke-dasharray="4,2"' : '';
    const arrowSvg = `<svg width="30" height="14" viewBox="0 0 30 14" style="vertical-align:middle;"><line x1="0" y1="7" x2="22" y2="7" stroke="${c.color}" stroke-width="2"${dashAttr}/><path d="M19,3 L26,7 L19,11" fill="${c.color}" stroke="none"/></svg>`;
    html += `<div class="legend-item"><span class="legend-conn-svg">${arrowSvg}</span><span>${c.label}</span></div>`;
  }
  container.innerHTML = html;
}

function clearLegend(): void {
  const container = document.getElementById('legend-overlay');
  if (container) container.innerHTML = '';
}

// ─── Zoom / Pan ──────────────────────────────────────────────
function setupZoomPan(): void {
  let panning = false, sx = 0, sy = 0;
  svgEl.addEventListener('mousedown', (e) => {
    if (e.button === 0) { panning = true; sx = e.clientX - currentTransform.x; sy = e.clientY - currentTransform.y; }
  });
  document.addEventListener('mousemove', (e) => {
    if (!panning) return;
    currentTransform.x = e.clientX - sx; currentTransform.y = e.clientY - sy;
    applyTransform();
  });
  document.addEventListener('mouseup', () => { panning = false; });
  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svgEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
}

function zoom(f: number): void { const r = svgEl.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }

function zoomAt(f: number, cx: number, cy: number): void {
  const nk = Math.max(0.1, Math.min(5, currentTransform.k * f));
  const ratio = nk / currentTransform.k;
  currentTransform.x = cx - ratio * (cx - currentTransform.x);
  currentTransform.y = cy - ratio * (cy - currentTransform.y);
  currentTransform.k = nk;
  applyTransform();
}

function resetView(): void { currentTransform = { x: 20, y: 20, k: 1 }; applyTransform(); }

function applyTransform(): void {
  rootG.setAttribute('transform', `translate(${currentTransform.x},${currentTransform.y}) scale(${currentTransform.k})`);
}

export {};
