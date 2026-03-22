/**
 * UVM Data Flow Diagram — pipeline-oriented rendering.
 *
 * Blocks are arranged left-to-right by their role in the UVM data pipeline:
 *   Sequence → Sequencer → Driver → [DUT] → Monitor → Scoreboard
 *
 * Container blocks (test, env, agent) act as grouping boxes.
 * DUT modules are shown inline between driver-side and monitor-side agents.
 * Arrows follow routed paths with distributed connection points to avoid overlap.
 */

interface TlmPort { kind: string; paramType: string; fieldName: string; }
interface TlmConnection { from: string; to: string; }
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
const PORT_AREA_H = 20;
const CHAR_W = 7.5;
const DUT_W = 140;
const DUT_H = 80;

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
let connectionCounts: Map<string, number> = new Map();
const MIN_CONN_SLOT = 16;
const CONN_MARGIN = 12;

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

  // Project dropdown change handler
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

// ─── Project dropdown ─────────────────────────────────────────
function updateProjectDropdown(): void {
  const dropdown = document.getElementById('project-dropdown') as HTMLSelectElement | null;
  if (!dropdown) return;

  if (allProjects.length <= 1) {
    dropdown.style.display = 'none';
    return;
  }

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

// ─── Connection count estimation ─────────────────────────────
function estimateConnectionCounts(roots: UvmDiagramNode[], duts: DutInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  const inc = (name: string) => counts.set(name, (counts.get(name) || 0) + 1);

  const processConns = (node: UvmDiagramNode) => {
    for (const conn of node.connections) {
      const srcClass = resolveFieldToClass(node, conn.from.split('.')[0]);
      const dstClass = resolveFieldToClass(node, conn.to.split('.')[0]);
      if (srcClass) inc(srcClass);
      if (dstClass) inc(dstClass);
    }
    for (const ch of node.children) processConns(ch);
  };
  for (const r of roots) processConns(r);

  const inferAgent = (node: UvmDiagramNode) => {
    if (node.uvmType === 'agent') {
      const drv = node.children.find(c => c.uvmType === 'driver');
      const seqr = node.children.find(c => c.uvmType === 'sequencer');
      if (drv && seqr) { inc(drv.className); inc(seqr.className); }
    }
    for (const ch of node.children) inferAgent(ch);
  };
  for (const r of roots) inferAgent(r);

  if (duts.length > 0) {
    const collectDM = (n: UvmDiagramNode) => {
      if (n.uvmType === 'driver' || n.uvmType === 'monitor') {
        inc(n.className);
        for (const d of duts) inc(d.moduleName);
      }
      for (const ch of n.children) collectDM(ch);
    };
    for (const r of roots) collectDM(r);
  }

  const sbNames: string[] = [];
  const apNames: string[] = [];
  const collectSbAp = (n: UvmDiagramNode) => {
    if (n.uvmType === 'scoreboard') sbNames.push(n.className);
    if ((n.uvmType === 'monitor' || n.uvmType === 'agent') &&
        n.tlmPorts.some(p => p.kind.includes('analysis'))) apNames.push(n.className);
    for (const ch of n.children) collectSbAp(ch);
  };
  for (const r of roots) collectSbAp(r);
  for (const sb of sbNames) {
    for (const _ap of apNames) { inc(sb); }
  }
  for (const ap of apNames) {
    for (const _sb of sbNames) { inc(ap); }
  }

  return counts;
}

// ─── Render (pipeline layout) ─────────────────────────────────
function renderProject(roots: UvmDiagramNode[], duts: DutInfo[]): void {
  const empty = document.getElementById('empty-state')!;
  const ctr = document.getElementById('diagram-container')!;
  if (roots.length === 0) { empty.style.display = 'flex'; ctr.style.display = 'none'; clearLegend(); return; }
  empty.style.display = 'none'; ctr.style.display = 'block';
  while (rootG.firstChild) rootG.removeChild(rootG.firstChild);
  drawnBlocks = [];

  // Collect ALL leaf components and containers from the UVM tree
  const allLeaves: { node: UvmDiagramNode; ancestors: UvmDiagramNode[] }[] = [];
  const collectLeaves = (n: UvmDiagramNode, ancestors: UvmDiagramNode[]) => {
    const pipelineChildren = n.children.filter(c => STAGE[c.uvmType] >= 0);
    const nonPipelineChildren = n.children.filter(c => STAGE[c.uvmType] < 0 && c.children.some(gc => STAGE[gc.uvmType] >= 0));

    if (pipelineChildren.length > 0) {
      for (const ch of pipelineChildren) {
        allLeaves.push({ node: ch, ancestors: [...ancestors, n] });
      }
    }
    // Recurse into container nodes (agents, envs)
    for (const ch of [...nonPipelineChildren, ...n.children.filter(c => c.uvmType === 'agent' || c.uvmType === 'env')]) {
      collectLeaves(ch, [...ancestors, n]);
    }
    // If this node has no pipeline children and IS a pipeline stage itself
    if (pipelineChildren.length === 0 && nonPipelineChildren.length === 0 && STAGE[n.uvmType] >= 0) {
      allLeaves.push({ node: n, ancestors });
    }
  };
  for (const r of roots) collectLeaves(r, []);

  // Sort leaves by pipeline stage
  allLeaves.sort((a, b) => (STAGE[a.node.uvmType] ?? 99) - (STAGE[b.node.uvmType] ?? 99));

  // Group by agent parent (if any)
  interface AgentGroup {
    agent?: UvmDiagramNode;
    env?: UvmDiagramNode;
    test?: UvmDiagramNode;
    members: UvmDiagramNode[];
  }
  const agentGroups: AgentGroup[] = [];
  const standaloneLeaves: { node: UvmDiagramNode; env?: UvmDiagramNode; test?: UvmDiagramNode }[] = [];

  for (const leaf of allLeaves) {
    const agentAncestor = leaf.ancestors.find(a => a.uvmType === 'agent');
    const envAncestor = leaf.ancestors.find(a => a.uvmType === 'env');
    const testAncestor = leaf.ancestors.find(a => a.uvmType === 'test');
    if (agentAncestor) {
      let group = agentGroups.find(g => g.agent === agentAncestor);
      if (!group) {
        group = { agent: agentAncestor, env: envAncestor, test: testAncestor, members: [] };
        agentGroups.push(group);
      }
      if (!group.members.includes(leaf.node)) group.members.push(leaf.node);
    } else {
      if (!standaloneLeaves.some(s => s.node === leaf.node)) {
        standaloneLeaves.push({ node: leaf.node, env: envAncestor, test: testAncestor });
      }
    }
  }

  // Sort members within each agent group by pipeline stage
  for (const g of agentGroups) {
    g.members.sort((a, b) => (STAGE[a.uvmType] ?? 99) - (STAGE[b.uvmType] ?? 99));
  }

  // Estimate connection counts for block sizing
  connectionCounts = estimateConnectionCounts(roots, duts);

  // ── Build the pipeline layout ──
  const envNode = roots.find(r => r.uvmType === 'test')?.children.find(c => c.uvmType === 'env')
    || roots.find(r => r.uvmType === 'env');
  const testNode = roots.find(r => r.uvmType === 'test');

  // Measure all agent groups and standalone blocks
  interface LayoutBlock {
    type: 'agent-group' | 'dut' | 'standalone' | 'sequence-group';
    stage: number;
    w: number;
    h: number;
    data: any;
  }

  const layoutBlocks: LayoutBlock[] = [];

  // Add agent groups (each agent is a column with its members stacked vertically)
  for (const g of agentGroups) {
    const memberSizes = g.members.map(m => measureLeaf(m));
    const w = Math.max(BLOCK_MIN_W + 20, ...memberSizes.map(s => s.w)) + PAD * 2;
    const h = HEADER_H + memberSizes.reduce((s, m) => s + m.h + GAP_Y, 0) - GAP_Y + PAD * 2;
    const minStage = Math.min(...g.members.map(m => STAGE[m.uvmType] ?? 3));
    layoutBlocks.push({ type: 'agent-group', stage: minStage, w, h, data: g });
  }

  // Add DUTs between agents
  for (const dut of duts) {
    const dutConnCount = connectionCounts.get(dut.moduleName) || 0;
    const dutConnH = dutConnCount > 1 ? dutConnCount * MIN_CONN_SLOT + 2 * CONN_MARGIN : 0;
    const dutH = Math.max(DUT_H, dutConnH);
    layoutBlocks.push({ type: 'dut', stage: 3, w: DUT_W, h: dutH, data: dut });
  }

  // Separate sequences from other standalone leaves and group them vertically
  const seqLeaves = standaloneLeaves.filter(s => s.node.uvmType === 'sequence');
  const nonSeqLeaves = standaloneLeaves.filter(s => s.node.uvmType !== 'sequence');

  if (seqLeaves.length > 1) {
    // Stack sequences vertically in a group
    const memberSizes = seqLeaves.map(s => measureLeaf(s.node));
    const w = Math.max(BLOCK_MIN_W + 20, ...memberSizes.map(s => s.w)) + PAD * 2;
    const h = HEADER_H + memberSizes.reduce((s, m) => s + m.h + GAP_Y, 0) - GAP_Y + PAD * 2;
    layoutBlocks.push({ type: 'sequence-group', stage: 0, w, h, data: seqLeaves });
  } else {
    for (const s of seqLeaves) {
      const sz = measureLeaf(s.node);
      layoutBlocks.push({ type: 'standalone', stage: 0, w: sz.w, h: sz.h, data: s });
    }
  }

  // Add non-sequence standalone blocks
  for (const s of nonSeqLeaves) {
    const sz = measureLeaf(s.node);
    layoutBlocks.push({ type: 'standalone', stage: STAGE[s.node.uvmType] ?? 5, w: sz.w, h: sz.h, data: s });
  }

  // Sort by pipeline stage
  layoutBlocks.sort((a, b) => a.stage - b.stage);

  // Compute positions: left-to-right by stage
  const envHeaderH = envNode ? HEADER_H : 0;
  const testHeaderH = testNode ? HEADER_H : 0;

  let curX = PAD + (testNode ? PAD : 0) + (envNode ? PAD : 0);
  const baseY = PAD + testHeaderH + envHeaderH;
  const maxBlockH = Math.max(DUT_H, ...layoutBlocks.map(b => b.h));

  const blockPositions: { block: LayoutBlock; x: number; y: number }[] = [];

  for (const block of layoutBlocks) {
    const y = baseY + (maxBlockH - block.h) / 2;
    blockPositions.push({ block, x: curX, y });
    curX += block.w + GAP_X;
  }

  const totalInnerW = curX - GAP_X + PAD;
  const totalInnerH = maxBlockH + PAD * 2;

  // Draw container boxes (test, env) first
  const envX = PAD + (testNode ? PAD : 0);
  const envY = PAD + testHeaderH;
  const envW = totalInnerW - (testNode ? PAD : 0);
  const envH = totalInnerH + envHeaderH;

  if (testNode) {
    const testW = totalInnerW + PAD;
    const testH = envH + testHeaderH + PAD;
    drawContainerBox(rootG, testNode, PAD, PAD, testW, testH);
  }

  if (envNode) {
    drawContainerBox(rootG, envNode, envX, envY, envW, envH);
  }

  // Draw each layout block at its computed position
  for (const { block, x, y } of blockPositions) {
    if (block.type === 'agent-group') {
      const g = block.data as AgentGroup;
      drawAgentGroup(rootG, g, x, y, block.w, block.h);
    } else if (block.type === 'dut') {
      const dut = block.data as DutInfo;
      drawDutBlock(rootG, dut, x, y, block.w, block.h);
    } else if (block.type === 'sequence-group') {
      const seqs = block.data as { node: UvmDiagramNode }[];
      drawSequenceGroup(rootG, seqs, x, y, block.w, block.h);
    } else {
      const s = block.data as { node: UvmDiagramNode };
      drawLeafBlock(rootG, s.node, x, y);
    }
  }

  // Draw connections
  drawAllConnections(rootG, roots);

  // Legend (HTML overlay instead of SVG)
  drawLegendOverlay();

  resetView();
}

// ─── Measure a leaf component ─────────────────────────────────
function measureLeaf(node: UvmDiagramNode): { w: number; h: number } {
  const textW = node.className.length * CHAR_W + PAD * 2 + ICON_SIZE + 8;
  const portH = node.tlmPorts.length > 0 ? PORT_AREA_H : 0;
  const baseH = BLOCK_MIN_H + portH;
  const connCount = connectionCounts.get(node.className) || 0;
  const connH = connCount > 1 ? connCount * MIN_CONN_SLOT + 2 * CONN_MARGIN : 0;
  return { w: Math.max(BLOCK_MIN_W, textW), h: Math.max(baseH, connH) };
}

// ─── Draw a container box (test/env — no nesting logic, just a labeled rect) ──
function drawContainerBox(parent: SVGGElement, node: UvmDiagramNode, x: number, y: number, w: number, h: number): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', `df-block df-${node.uvmType}`);
  const theme = THEMES[node.uvmType] || THEMES.unknown;

  g.appendChild(attrs(el('rect'), {
    x: 0, y: 0, width: w, height: h, rx: 8,
    fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2, opacity: 0.6,
  }));
  const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
  lbl.textContent = node.className;
  g.appendChild(lbl);
  const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
  badge.textContent = `[${node.uvmType}]`;
  g.appendChild(badge);
  drawIcon(g, node.uvmType, w, theme.accent);

  g.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'openFile', filePath: node.filePath, line: node.line });
  });

  parent.appendChild(g);
}

// ─── Draw an agent group (agent container + its pipeline members) ──
function drawAgentGroup(parent: SVGGElement, group: { agent?: UvmDiagramNode; members: UvmDiagramNode[] }, x: number, y: number, w: number, h: number): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);

  if (group.agent) {
    const theme = THEMES.agent;
    g.setAttribute('class', `df-block df-agent`);
    g.appendChild(attrs(el('rect'), {
      x: 0, y: 0, width: w, height: h, rx: 6,
      fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2,
    }));
    const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
    lbl.textContent = group.agent.className;
    g.appendChild(lbl);
    const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
    badge.textContent = '[agent]';
    g.appendChild(badge);
    drawIcon(g, 'agent', w, theme.accent);

    g.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: 'openFile', filePath: group.agent!.filePath, line: group.agent!.line });
    });
  }

  // Draw members stacked vertically within the agent
  let my = HEADER_H;
  for (const member of group.members) {
    const sz = measureLeaf(member);
    const mx = PAD;
    drawLeafBlock(g, member, mx, my);
    my += sz.h + GAP_Y;
  }

  parent.appendChild(g);

  // Register agent block for connections
  const abs = absPos(g);
  if (group.agent) {
    drawnBlocks.push({ x: abs.x, y: abs.y, w, h, node: group.agent, kind: 'uvm', stage: -1 });
  }
}

// ─── Draw a sequence group (stacked sequences) ───────────────
function drawSequenceGroup(parent: SVGGElement, seqs: { node: UvmDiagramNode }[], x: number, y: number, w: number, h: number): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);

  const theme = THEMES.sequence;
  g.setAttribute('class', 'df-block df-sequence-group');
  g.appendChild(attrs(el('rect'), {
    x: 0, y: 0, width: w, height: h, rx: 6,
    fill: 'rgba(21,42,42,0.5)', stroke: theme.stroke, 'stroke-width': 1, 'stroke-dasharray': '4,2',
  }));
  const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
  lbl.textContent = 'Sequences';
  g.appendChild(lbl);
  const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
  badge.textContent = `[${seqs.length} sequences]`;
  g.appendChild(badge);

  let my = HEADER_H;
  for (const s of seqs) {
    const sz = measureLeaf(s.node);
    drawLeafBlock(g, s.node, PAD, my);
    my += sz.h + GAP_Y;
  }

  parent.appendChild(g);
}

// ─── Draw a leaf block (sequencer, driver, monitor, scoreboard, etc.) ──
function drawLeafBlock(parent: SVGGElement, node: UvmDiagramNode, x: number, y: number): void {
  const sz = measureLeaf(node);
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', `df-block df-${node.uvmType}`);
  g.setAttribute('data-class', node.className);
  const theme = THEMES[node.uvmType] || THEMES.unknown;

  g.appendChild(attrs(el('rect'), {
    x: 0, y: 0, width: sz.w, height: sz.h, rx: 6,
    fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2,
  }));
  const lbl = attrs(el('text'), { x: PAD / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
  lbl.textContent = node.className;
  g.appendChild(lbl);
  const badge = attrs(el('text'), { x: PAD / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
  badge.textContent = `[${node.uvmType}]`;
  g.appendChild(badge);
  drawIcon(g, node.uvmType, sz.w, theme.accent);
  drawPorts(g, node, sz.w, sz.h, theme);

  g.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'openFile', filePath: node.filePath, line: node.line });
  });

  parent.appendChild(g);
  const abs = absPos(g);
  drawnBlocks.push({ x: abs.x, y: abs.y, w: sz.w, h: sz.h, node, kind: 'uvm', stage: STAGE[node.uvmType] ?? 3 });
}

// ─── Draw DUT block ──────────────────────────────────────────
function drawDutBlock(parent: SVGGElement, dut: DutInfo, x: number, y: number, w: number, h: number): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', 'df-block df-dut');
  const theme = THEMES.dut;

  g.appendChild(attrs(el('rect'), {
    x: 0, y: 0, width: w, height: h, rx: 4,
    fill: theme.fill, stroke: theme.stroke, 'stroke-width': 3,
  }));
  g.appendChild(attrs(el('rect'), {
    x: 4, y: 4, width: w - 8, height: h - 8, rx: 3,
    fill: 'none', stroke: theme.stroke, 'stroke-width': 1, opacity: 0.4,
  }));

  const textBaseY = h / 2 - 14;
  const lbl = attrs(el('text'), { x: w / 2, y: textBaseY, 'text-anchor': 'middle', class: 'df-label' }) as SVGTextElement;
  lbl.textContent = dut.moduleName;
  g.appendChild(lbl);
  const badge = attrs(el('text'), { x: w / 2, y: textBaseY + 16, 'text-anchor': 'middle', class: 'df-type', fill: theme.accent }) as SVGTextElement;
  badge.textContent = '[DUT]';
  g.appendChild(badge);
  if (dut.instanceName) {
    const inst = attrs(el('text'), { x: w / 2, y: textBaseY + 32, 'text-anchor': 'middle', 'font-size': 9, fill: '#999' }) as SVGTextElement;
    inst.textContent = `inst: ${dut.instanceName}`;
    g.appendChild(inst);
  }
  drawIcon(g, 'dut', w, theme.accent);

  g.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'openFile', filePath: dut.filePath, line: dut.line });
  });

  parent.appendChild(g);

  const dutNode: UvmDiagramNode = {
    className: dut.moduleName, uvmType: 'dut', baseClass: '', filePath: dut.filePath,
    line: dut.line, children: [], fields: [], tlmPorts: [], connections: [], virtualIfs: [],
  };
  const abs = absPos(g);
  drawnBlocks.push({ x: abs.x, y: abs.y, w, h, node: dutNode, kind: 'dut', stage: 3 });
}

// ─── Connection system (improved routing) ─────────────────────

function resolveFieldToClass(parent: UvmDiagramNode, fieldName: string): string | undefined {
  for (const f of parent.fields) {
    if (f.fieldName === fieldName) return f.typeName;
  }
  for (const ch of parent.children) {
    if (ch.className.toLowerCase() === fieldName.toLowerCase()) return ch.className;
  }
  return undefined;
}

function findBlockByClass(className: string): BlockRect | undefined {
  return drawnBlocks.find(b => b.node.className === className);
}

interface Arrow {
  from: BlockRect; to: BlockRect;
  label: string; color: string;
  marker: string; dashed: boolean;
}

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
      const isAnalysis = portName.includes('analysis') || conn.to.includes('analysis') ||
                         portName.includes('_ap') || conn.to.includes('_fifo');

      let label: string, color: string, marker: string;
      if (isSeqItem) { label = 'seq_item_port'; color = '#c586c0'; marker = 'ah-seq'; }
      else if (isAnalysis) { label = 'analysis_port'; color = '#d16969'; marker = 'ah-ap'; }
      else { label = portName.length > 18 ? portName.slice(0, 16) + '..' : (portName || 'connect'); color = '#8888cc'; marker = 'ah'; }

      arrows.push({ from: srcBlock, to: dstBlock, label, color, marker, dashed: false });
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
        if (drvB && seqrB && !arrows.some(a =>
          (a.from === drvB && a.to === seqrB) || (a.from === seqrB && a.to === drvB))) {
          arrows.push({ from: seqrB, to: drvB, label: 'seq_item_port', color: '#c586c0', marker: 'ah-seq', dashed: false });
        }
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
      else if (comp.parentAgent) {
        for (const ch of comp.parentAgent.children) {
          if (ch.virtualIfs.length > 0) { vif = ch.virtualIfs[0]; break; }
        }
      }
      const label = vif || 'vif';
      const dut = dutBlocks.length === 1 ? dutBlocks[0] : nearest(comp.block, dutBlocks);

      if (comp.node.uvmType === 'driver') {
        arrows.push({ from: comp.block, to: dut, label, color: '#e6b422', marker: 'ah-dut', dashed: true });
      } else {
        arrows.push({ from: dut, to: comp.block, label, color: '#e6b422', marker: 'ah-dut', dashed: true });
      }
    }
  }

  // 4. Monitor/Agent → Scoreboard
  const sbBlocks = drawnBlocks.filter(b => b.node.uvmType === 'scoreboard');
  const agentBlocks = drawnBlocks.filter(b => b.node.uvmType === 'agent');
  for (const sb of sbBlocks) {
    if (!arrows.some(a => a.to === sb)) {
      for (const ag of agentBlocks) {
        if (ag.node.tlmPorts.some(p => p.kind.includes('analysis'))) {
          arrows.push({ from: ag, to: sb, label: 'analysis_port', color: '#d16969', marker: 'ah-ap', dashed: false });
        }
      }
      if (!arrows.some(a => a.to === sb)) {
        const monBlocks = drawnBlocks.filter(b => b.node.uvmType === 'monitor' && b.node.tlmPorts.some(p => p.kind.includes('analysis')));
        for (const mon of monBlocks) {
          arrows.push({ from: mon, to: sb, label: 'analysis_port', color: '#d16969', marker: 'ah-ap', dashed: false });
        }
      }
    }
  }

  if (arrows.length === 0) return;

  const cg = el('g') as SVGGElement;
  cg.setAttribute('class', 'df-connections');

  // ── Improved arrow routing: distribute connection points per block side ──
  routeAndDrawArrows(cg, arrows);

  parent.appendChild(cg);
}

// ─── Arrow routing engine ─────────────────────────────────────

interface RoutedArrow {
  arrow: Arrow;
  srcSide: 'top' | 'right' | 'bottom' | 'left';
  tgtSide: 'top' | 'right' | 'bottom' | 'left';
  srcX: number; srcY: number;
  tgtX: number; tgtY: number;
  srcSlotIdx: number; srcSlotCount: number;
  tgtSlotIdx: number; tgtSlotCount: number;
}

function routeAndDrawArrows(parent: SVGGElement, arrows: Arrow[]): void {
  // Step 1: Determine preferred exit/entry sides for each arrow
  const routed: RoutedArrow[] = [];

  for (const a of arrows) {
    const fromCy = a.from.y + a.from.h / 2;
    const toCy = a.to.y + a.to.h / 2;

    let srcSide: 'top' | 'right' | 'bottom' | 'left';
    let tgtSide: 'top' | 'right' | 'bottom' | 'left';

    // Prefer horizontal (left/right) if blocks don't overlap horizontally
    if (a.from.x + a.from.w + 2 < a.to.x) {
      // Source is left of target → right → left
      srcSide = 'right';
      tgtSide = 'left';
    } else if (a.to.x + a.to.w + 2 < a.from.x) {
      // Source is right of target → left → right
      srcSide = 'left';
      tgtSide = 'right';
    } else if (fromCy <= toCy) {
      // Vertically stacked — exit bottom, enter top
      srcSide = 'bottom';
      tgtSide = 'top';
    } else {
      srcSide = 'top';
      tgtSide = 'bottom';
    }

    routed.push({ arrow: a, srcSide, tgtSide, srcX: 0, srcY: 0, tgtX: 0, tgtY: 0, srcSlotIdx: 0, srcSlotCount: 1, tgtSlotIdx: 0, tgtSlotCount: 1 });
  }

  // Step 2: For each block+side, collect connected arrows and distribute points
  interface SideSlot {
    ra: RoutedArrow;
    isSource: boolean; // true = outgoing, false = incoming
    otherBlock: BlockRect;
  }

  const sideMap = new Map<string, SideSlot[]>();

  for (const ra of routed) {
    const srcKey = `${ra.arrow.from.node.className}::${ra.srcSide}`;
    const tgtKey = `${ra.arrow.to.node.className}::${ra.tgtSide}`;

    if (!sideMap.has(srcKey)) sideMap.set(srcKey, []);
    sideMap.get(srcKey)!.push({ ra, isSource: true, otherBlock: ra.arrow.to });

    if (!sideMap.has(tgtKey)) sideMap.set(tgtKey, []);
    sideMap.get(tgtKey)!.push({ ra, isSource: false, otherBlock: ra.arrow.from });
  }

  // For each side, sort by other endpoint position and assign evenly-spaced points
  for (const [key, slots] of sideMap) {
    const side = key.split('::')[1] as 'top' | 'right' | 'bottom' | 'left';

    // Find the block for this side
    const block = slots[0].isSource ? slots[0].ra.arrow.from : slots[0].ra.arrow.to;

    // Sort by other endpoint's center to minimize crossings
    slots.sort((a, b) => {
      const aCx = a.otherBlock.x + a.otherBlock.w / 2;
      const aCy = a.otherBlock.y + a.otherBlock.h / 2;
      const bCx = b.otherBlock.x + b.otherBlock.w / 2;
      const bCy = b.otherBlock.y + b.otherBlock.h / 2;
      if (side === 'right' || side === 'left') {
        return aCy - bCy; // Sort by Y position of other endpoint
      } else {
        return aCx - bCx; // Sort by X position of other endpoint
      }
    });

    const count = slots.length;
    const margin = 12; // minimum margin from block corners

    for (let i = 0; i < count; i++) {
      // Distribute evenly along the side
      const t = count === 1 ? 0.5 : (margin + ((side === 'right' || side === 'left'
        ? (block.h - 2 * margin)
        : (block.w - 2 * margin)) * i / (count - 1))) / (side === 'right' || side === 'left' ? block.h : block.w);

      let px: number, py: number;
      switch (side) {
        case 'right':
          px = block.x + block.w;
          py = block.y + block.h * t;
          break;
        case 'left':
          px = block.x;
          py = block.y + block.h * t;
          break;
        case 'bottom':
          px = block.x + block.w * t;
          py = block.y + block.h;
          break;
        case 'top':
          px = block.x + block.w * t;
          py = block.y;
          break;
      }

      if (slots[i].isSource) {
        slots[i].ra.srcX = px;
        slots[i].ra.srcY = py;
        slots[i].ra.srcSlotIdx = i;
        slots[i].ra.srcSlotCount = count;
      } else {
        slots[i].ra.tgtX = px;
        slots[i].ra.tgtY = py;
        slots[i].ra.tgtSlotIdx = i;
        slots[i].ra.tgtSlotCount = count;
      }
    }
  }

  // Step 3: Draw each arrow with cubic Bezier curves
  for (const ra of routed) {
    drawRoutedArrow(parent, ra);
  }
}

function drawRoutedArrow(parent: SVGGElement, ra: RoutedArrow): void {
  const { arrow: a, srcSide, tgtSide, srcX: x1, srcY: y1, tgtX: x2, tgtY: y2 } = ra;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const baseCpDist = Math.max(30, Math.min(80, dist * 0.35));

  // Vary control point distance per slot to fan out parallel curves
  const srcFan = ra.srcSlotCount > 1 ? (ra.srcSlotIdx - (ra.srcSlotCount - 1) / 2) * 14 : 0;
  const tgtFan = ra.tgtSlotCount > 1 ? (ra.tgtSlotIdx - (ra.tgtSlotCount - 1) / 2) * 14 : 0;

  // Control points extend outward from the side, with perpendicular fan offset
  let cp1x: number, cp1y: number, cp2x: number, cp2y: number;

  switch (srcSide) {
    case 'right':  cp1x = x1 + baseCpDist + Math.abs(srcFan) * 0.5; cp1y = y1 + srcFan; break;
    case 'left':   cp1x = x1 - baseCpDist - Math.abs(srcFan) * 0.5; cp1y = y1 + srcFan; break;
    case 'bottom': cp1x = x1 + srcFan; cp1y = y1 + baseCpDist + Math.abs(srcFan) * 0.5; break;
    case 'top':    cp1x = x1 + srcFan; cp1y = y1 - baseCpDist - Math.abs(srcFan) * 0.5; break;
  }

  switch (tgtSide) {
    case 'right':  cp2x = x2 + baseCpDist + Math.abs(tgtFan) * 0.5; cp2y = y2 + tgtFan; break;
    case 'left':   cp2x = x2 - baseCpDist - Math.abs(tgtFan) * 0.5; cp2y = y2 + tgtFan; break;
    case 'bottom': cp2x = x2 + tgtFan; cp2y = y2 + baseCpDist + Math.abs(tgtFan) * 0.5; break;
    case 'top':    cp2x = x2 + tgtFan; cp2y = y2 - baseCpDist - Math.abs(tgtFan) * 0.5; break;
  }

  // ── Collision avoidance: route around intermediate blocks ──
  const possibleBlockers = drawnBlocks.filter(b => {
    if (b.node.className === a.from.node.className || b.node.className === a.to.node.className) return false;
    const minX = Math.min(x1, x2) - 10;
    const maxX = Math.max(x1, x2) + 10;
    return b.x + b.w > minX && b.x < maxX;
  });

  if (possibleBlockers.length > 0) {
    const collidedBlocks: BlockRect[] = [];
    for (let t = 0.02; t <= 0.98; t += 0.02) {
      const mt = 1 - t;
      const px = mt * mt * mt * x1 + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x2;
      const py = mt * mt * mt * y1 + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y2;
      for (const b of possibleBlockers) {
        if (px > b.x - 4 && px < b.x + b.w + 4 && py > b.y - 4 && py < b.y + b.h + 4) {
          if (!collidedBlocks.includes(b)) collidedBlocks.push(b);
        }
      }
    }

    if (collidedBlocks.length > 0) {
      const minBlockY = Math.min(...collidedBlocks.map(b => b.y));
      const maxBlockY = Math.max(...collidedBlocks.map(b => b.y + b.h));
      const CLEARANCE = 24;
      const goAbove = (y1 + y2) / 2 <= (minBlockY + maxBlockY) / 2;
      const routeY = goAbove ? minBlockY - CLEARANCE : maxBlockY + CLEARANCE;
      cp1y = routeY;
      cp2y = routeY;
    }
  }

  const d = `M${x1},${y1} C${cp1x},${cp1y} ${cp2x},${cp2y} ${x2},${y2}`;

  parent.appendChild(attrs(el('path'), {
    d,
    class: 'df-arrow',
    stroke: a.color, 'stroke-width': 1.8, fill: 'none',
    'stroke-dasharray': a.dashed ? '6,3' : 'none',
    'marker-end': `url(#${a.marker})`,
  }));

  if (a.label) {
    // Place label at t=0.3 on cubic Bezier
    const t = 0.3;
    const mt = 1 - t;
    const lx = mt * mt * mt * x1 + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x2;
    const ly = mt * mt * mt * y1 + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y2;
    const displayLabel = a.label.length > 20 ? a.label.slice(0, 18) + '..' : a.label;
    const tw = displayLabel.length * 5 + 10;

    parent.appendChild(attrs(el('rect'), {
      x: lx - tw / 2, y: ly - 7, width: tw, height: 14,
      rx: 3, fill: '#111', opacity: 0.92, stroke: a.color, 'stroke-width': 0.5,
    }));
    const lbl = attrs(el('text'), {
      x: lx, y: ly + 3, 'text-anchor': 'middle',
      'font-size': 8, fill: a.color, class: 'df-arrow-label',
    }) as SVGTextElement;
    lbl.textContent = displayLabel;
    parent.appendChild(lbl);
  }
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

// ─── Absolute position helper ─────────────────────────────────
function absPos(e: SVGElement): { x: number; y: number } {
  let x = 0, y = 0;
  let cur: SVGElement | null = e;
  while (cur && cur !== rootG) {
    const t = cur.getAttribute('transform');
    if (t) {
      const m = t.match(/translate\(([\d.-]+),([\d.-]+)\)/);
      if (m) { x += parseFloat(m[1]); y += parseFloat(m[2]); }
    }
    cur = cur.parentElement as SVGElement | null;
  }
  return { x, y };
}

// ─── TLM port indicators ─────────────────────────────────────
function drawPorts(g: SVGGElement, node: UvmDiagramNode, w: number, h: number, theme: Theme): void {
  if (node.tlmPorts.length === 0) return;
  const py = h - PORT_AREA_H + PORT_R + 2;
  const tw = node.tlmPorts.length * PORT_GAP;
  let sx = (w - tw) / 2 + PORT_GAP / 2;
  for (const port of node.tlmPorts) {
    const isExp = port.kind.includes('export') || port.kind.includes('imp');
    if (isExp) {
      const sq = attrs(el('rect'), { x: sx - PORT_R, y: py - PORT_R, width: PORT_R * 2, height: PORT_R * 2, rx: 1, fill: theme.accent, stroke: '#fff', 'stroke-width': 0.8 });
      const title = el('title') as SVGTitleElement;
      title.textContent = `${port.fieldName}: ${port.kind} #(${port.paramType})`;
      sq.appendChild(title);
      g.appendChild(sq);
    } else {
      const c = attrs(el('circle'), { cx: sx, cy: py, r: PORT_R, fill: theme.accent, stroke: '#fff', 'stroke-width': 0.8 });
      const title = el('title') as SVGTitleElement;
      title.textContent = `${port.fieldName}: ${port.kind} #(${port.paramType})`;
      c.appendChild(title);
      g.appendChild(c);
    }
    const lbl = attrs(el('text'), { x: sx, y: py + PORT_R + 9, 'text-anchor': 'middle', 'font-size': 7, fill: '#999', class: 'df-port-label' }) as SVGTextElement;
    lbl.textContent = port.fieldName.length > 10 ? port.fieldName.slice(0, 9) + '..' : port.fieldName;
    g.appendChild(lbl);
    sx += PORT_GAP;
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

// ─── Legend icon SVG helper ─────────────────────────────────────
function legendIconHtml(type: string): string {
  const c = THEMES[type]?.stroke || '#888';
  const s = `stroke="${c}" fill="none" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"`;
  switch (type) {
    case 'test':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M5,1 h4 M6,1 v3.5 L3,10.5 a1.5,1.5,0,0,0,1.3,2.2 h5.4 a1.5,1.5,0,0,0,1.3-2.2 L8,4.5 v-3.5"/><polyline ${s} points="5.5,10 6.5,11 8.5,9"/></svg>`;
    case 'env':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M7,13 v-5 Q7,3 12,2 Q11,8 7,8"/><path ${s} d="M7,10 Q3,4 2,2 Q7,3 7,8"/></svg>`;
    case 'agent':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="1.5" y="5" width="11" height="8" rx="1.5"/><path ${s} d="M5,5 v-2 a1,1,0,0,1,1-1 h2 a1,1,0,0,1,1,1 v2"/><line ${s} x1="1.5" y1="9" x2="12.5" y2="9"/></svg>`;
    case 'driver':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M2,4 h6 l-2,-2.5 M8,4 l-2,2.5"/><path ${s} d="M2,10 h6 l-2,-2.5 M8,10 l-2,2.5"/><line stroke="${c}" stroke-width="1.5" stroke-linecap="round" x1="10" y1="2" x2="10" y2="12"/></svg>`;
    case 'monitor':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="1.5" y="1.5" width="11" height="8" rx="1.5"/><line ${s} x1="7" y1="9.5" x2="7" y2="12"/><line ${s} x1="4" y1="12" x2="10" y2="12"/><polyline ${s} points="3.5,5.5 5,3.5 6.5,7 8,4 9.5,6.5 11,4.5"/></svg>`;
    case 'sequencer':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><polyline ${s} points="4,2 7,5 10,2"/><polyline ${s} points="4,5.5 7,8.5 10,5.5"/><polyline ${s} points="4,9 7,12 10,9"/></svg>`;
    case 'scoreboard':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><line ${s} x1="7" y1="1.5" x2="7" y2="10"/><line ${s} x1="3" y1="3.5" x2="11" y2="3.5"/><path ${s} d="M3,3.5 L1.5,7.5 h3 z"/><path ${s} d="M11,3.5 L9.5,7.5 h3 z"/><polygon points="5,12 9,12 7,10" stroke="${c}" fill="${c}" opacity="0.3" stroke-width="1.2"/></svg>`;
    case 'sequence':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="3" y="1" width="9" height="6" rx="1"/><rect ${s} x="1.5" y="3.5" width="9" height="6" rx="1"/><rect ${s} x="0" y="6" width="9" height="6" rx="1"/></svg>`;
    case 'component':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="3.5" y="2" width="7" height="10" rx="1"/><line ${s} x1="1" y1="5" x2="3.5" y2="5"/><line ${s} x1="1" y1="9" x2="3.5" y2="9"/><line ${s} x1="10.5" y1="5" x2="13" y2="5"/><line ${s} x1="10.5" y1="9" x2="13" y2="9"/></svg>`;
    case 'dut':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="3" y="2" width="8" height="10" rx="1"/><line ${s} x1="0" y1="4" x2="3" y2="4"/><line ${s} x1="0" y1="7" x2="3" y2="7"/><line ${s} x1="0" y1="10" x2="3" y2="10"/><line ${s} x1="11" y1="4" x2="14" y2="4"/><line ${s} x1="11" y1="7" x2="14" y2="7"/><line ${s} x1="11" y1="10" x2="14" y2="10"/><line ${s} x1="5" y1="0" x2="5" y2="2"/><line ${s} x1="9" y1="0" x2="9" y2="2"/></svg>`;
    case 'object':
      return `<svg width="14" height="14" viewBox="0 0 14 14"><path ${s} d="M2,1.5 h6.5 l3,3 v8 a1,1,0,0,1-1,1 h-8.5 a1,1,0,0,1-1-1 v-10 a1,1,0,0,1,1-1 z"/><path ${s} d="M8.5,1.5 v3 h3"/></svg>`;
    default:
      return `<svg width="14" height="14" viewBox="0 0 14 14"><rect ${s} x="2" y="2" width="10" height="10" rx="2"/></svg>`;
  }
}

// ─── Legend (HTML overlay — never overlaps diagram) ────────────
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
    html += `<div class="legend-item">
      <span class="legend-swatch" style="background:${th.fill};border:1.5px solid ${th.stroke};"></span>
      <span class="legend-icon-svg">${legendIconHtml(t)}</span>
      <span>${t}</span>
    </div>`;
  }

  html += '<div class="legend-section-title">Connections</div>';

  for (const c of connTypes) {
    const dashAttr = c.dashed ? ' stroke-dasharray="4,2"' : '';
    const arrowSvg = `<svg width="30" height="14" viewBox="0 0 30 14" style="vertical-align:middle;">` +
      `<line x1="0" y1="7" x2="22" y2="7" stroke="${c.color}" stroke-width="2"${dashAttr}/>` +
      `<path d="M19,3 L26,7 L19,11" fill="${c.color}" stroke="none"/>` +
      `</svg>`;
    html += `<div class="legend-item">
      <span class="legend-conn-svg">${arrowSvg}</span>
      <span>${c.label}</span>
    </div>`;
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
