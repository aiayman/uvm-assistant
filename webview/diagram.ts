/**
 * UVM Data Flow Diagram — rendering logic (runs inside VS Code webview).
 *
 * All blocks are rectangles differentiated by color and a small symbolic icon
 * in the top-right corner. TLM port indicators sit on block edges, and curved
 * arrows show data-flow connections parsed from connect_phase.
 */

interface TlmPort {
  kind: string;
  paramType: string;
  fieldName: string;
}

interface TlmConnection {
  from: string;
  to: string;
}

interface UvmDiagramNode {
  className: string;
  uvmType: string;
  baseClass: string;
  filePath: string;
  line: number;
  children: UvmDiagramNode[];
  tlmPorts: TlmPort[];
  connections: TlmConnection[];
}

const vscode = (window as any).acquireVsCodeApi();

// ─── Layout constants ─────────────────────────────────────────
const PADDING = 24;
const HEADER_H = 48;
const BLOCK_MIN_W = 160;
const BLOCK_MIN_H = 70;
const GAP = 20;
const LABEL_Y = 20;
const TYPE_Y = 36;
const ICON_SIZE = 16;
const PORT_R = 5;
const PORT_GAP = 18;
const PORT_AREA_H = 22;
const CHAR_W = 7.8;

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
  unknown:    { fill: '#222',    stroke: '#666',    accent: '#666'    },
};

// ─── State ────────────────────────────────────────────────────
let svgEl: SVGSVGElement;
let rootG: SVGGElement;
let currentTransform = { x: 0, y: 0, k: 1 };

interface BlockRect { x: number; y: number; w: number; h: number; node: UvmDiagramNode }
let drawnBlocks: BlockRect[] = [];

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

  // Arrowhead marker
  const defs = el('defs');
  defs.innerHTML = `
    <marker id="ah" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L6,3 L0,6" fill="#8888cc"/>
    </marker>`;
  svgEl.appendChild(defs);

  setupZoomPan();
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoom(1.2));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoom(0.8));
  document.getElementById('btn-reset')?.addEventListener('click', resetView);
  vscode.postMessage({ command: 'ready' });
});

window.addEventListener('message', (ev) => {
  if (ev.data.command === 'renderDiagram') render(ev.data.data as UvmDiagramNode[]);
});

// ─── Render ───────────────────────────────────────────────────
function render(roots: UvmDiagramNode[]): void {
  const empty = document.getElementById('empty-state')!;
  const ctr = document.getElementById('diagram-container')!;
  if (roots.length === 0) { empty.style.display = 'flex'; ctr.style.display = 'none'; return; }
  empty.style.display = 'none'; ctr.style.display = 'block';
  while (rootG.firstChild) rootG.removeChild(rootG.firstChild);
  drawnBlocks = [];

  let ox = PADDING;
  for (const root of roots) {
    const s = measure(root);
    drawNode(rootG, root, ox, PADDING, s.w, s.h);
    ox += s.w + GAP;
  }
  drawConnections(rootG, roots);
  drawLegend(rootG, ox + GAP * 2, PADDING);
  resetView();
}

// ─── Measure ──────────────────────────────────────────────────
function measure(node: UvmDiagramNode): { w: number; h: number } {
  const textW = node.className.length * CHAR_W + PADDING * 2 + ICON_SIZE + 8;
  const portH = node.tlmPorts.length > 0 ? PORT_AREA_H : 0;
  const baseH = BLOCK_MIN_H + portH;

  if (node.children.length === 0) {
    return { w: Math.max(BLOCK_MIN_W, textW), h: baseH };
  }
  const cs = node.children.map(c => measure(c));
  const tw = cs.reduce((s, c) => s + c.w, 0) + GAP * (cs.length - 1);
  const mh = Math.max(...cs.map(c => c.h));
  return {
    w: Math.max(BLOCK_MIN_W, textW, tw + PADDING * 2),
    h: Math.max(baseH, HEADER_H + portH + mh + PADDING * 2),
  };
}

// ─── Draw node ────────────────────────────────────────────────
function drawNode(
  parent: SVGGElement, node: UvmDiagramNode,
  x: number, y: number, w: number, h: number,
): void {
  const g = el('g') as SVGGElement;
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', `df-block df-${node.uvmType}`);
  g.setAttribute('data-class', node.className);

  const theme = THEMES[node.uvmType] || THEMES.unknown;

  // Rectangle
  g.appendChild(attrs(el('rect'), {
    x: 0, y: 0, width: w, height: h, rx: 6, ry: 6,
    fill: theme.fill, stroke: theme.stroke, 'stroke-width': 2,
  }));

  // Class name label
  const lbl = attrs(el('text'), { x: PADDING / 2, y: LABEL_Y, class: 'df-label' }) as SVGTextElement;
  lbl.textContent = node.className;
  g.appendChild(lbl);

  // Type badge
  const badge = attrs(el('text'), { x: PADDING / 2, y: TYPE_Y, class: 'df-type' }) as SVGTextElement;
  badge.textContent = `[${node.uvmType}]`;
  g.appendChild(badge);

  // Symbolic icon in top-right corner
  drawIcon(g, node.uvmType, w, theme.accent);

  // TLM port indicators
  drawPorts(g, node, w, h, theme);

  // Click handler
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'openFile', filePath: node.filePath, line: node.line });
  });

  // Children
  if (node.children.length > 0) {
    const cs = node.children.map(c => measure(c));
    let cx = PADDING;
    const cy = HEADER_H;
    for (let i = 0; i < node.children.length; i++) {
      drawNode(g, node.children[i], cx, cy, cs[i].w, cs[i].h);
      cx += cs[i].w + GAP;
    }
  }

  parent.appendChild(g);

  // Track absolute position for connection arrows
  const abs = absPos(g);
  drawnBlocks.push({ x: abs.x, y: abs.y, w, h, node });
}

// ─── Symbolic icons (top-right corner) ────────────────────────
// Each icon is a small ~14x14 SVG drawing at position (w-22, 6)

function drawIcon(g: SVGGElement, type: string, w: number, color: string): void {
  const ix = w - 22;
  const iy = 6;
  const ig = el('g') as SVGGElement;
  ig.setAttribute('transform', `translate(${ix},${iy})`);
  ig.setAttribute('class', 'df-icon');

  const s = (tag: string, a: Record<string, string | number>): SVGElement => {
    const e = attrs(el(tag), { ...a, stroke: color, fill: 'none', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    return e;
  };

  switch (type) {
    case 'test':
      // Flask with checkmark
      ig.appendChild(s('path', { d: 'M5,1 h4 M6,1 v3.5 L3,10.5 a1.5,1.5,0,0,0,1.3,2.2 h5.4 a1.5,1.5,0,0,0,1.3-2.2 L8,4.5 v-3.5' }));
      ig.appendChild(s('polyline', { points: '5.5,10 6.5,11 8.5,9' }));
      break;

    case 'env':
      // Leaf / seedling
      ig.appendChild(s('path', { d: 'M7,13 v-5 Q7,3 12,2 Q11,8 7,8' }));
      ig.appendChild(s('path', { d: 'M7,10 Q3,4 2,2 Q7,3 7,8' }));
      break;

    case 'agent':
      // Briefcase
      ig.appendChild(s('rect', { x: 1.5, y: 5, width: 11, height: 8, rx: 1.5 }));
      ig.appendChild(s('path', { d: 'M5,5 v-2 a1,1,0,0,1,1-1 h2 a1,1,0,0,1,1,1 v2' }));
      ig.appendChild(s('line', { x1: 1.5, y1: 9, x2: 12.5, y2: 9 }));
      break;

    case 'driver':
      // Bold right arrow (push/inject)
      ig.appendChild(s('path', { d: 'M2,4 h6 l-2,-2.5 M8,4 l-2,2.5' }));
      ig.appendChild(s('path', { d: 'M2,10 h6 l-2,-2.5 M8,10 l-2,2.5' }));
      ig.appendChild(attrs(el('line'), { x1: 10, y1: 2, x2: 10, y2: 12, stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
      break;

    case 'monitor':
      // Monitor screen
      ig.appendChild(s('rect', { x: 1.5, y: 1.5, width: 11, height: 8, rx: 1.5 }));
      ig.appendChild(s('line', { x1: 7, y1: 9.5, x2: 7, y2: 12 }));
      ig.appendChild(s('line', { x1: 4, y1: 12, x2: 10, y2: 12 }));
      // Signal wave inside screen
      ig.appendChild(s('polyline', { points: '3.5,5.5 5,3.5 6.5,7 8,4 9.5,6.5 11,4.5' }));
      break;

    case 'sequencer':
      // Stacked arrows pointing down (queue/flow)
      ig.appendChild(s('polyline', { points: '4,2 7,5 10,2' }));
      ig.appendChild(s('polyline', { points: '4,5.5 7,8.5 10,5.5' }));
      ig.appendChild(s('polyline', { points: '4,9 7,12 10,9' }));
      break;

    case 'scoreboard':
      // Balance scale
      ig.appendChild(s('line', { x1: 7, y1: 1.5, x2: 7, y2: 10 }));
      ig.appendChild(s('line', { x1: 3, y1: 3.5, x2: 11, y2: 3.5 }));
      ig.appendChild(s('path', { d: 'M3,3.5 L1.5,7.5 h3 z' }));
      ig.appendChild(s('path', { d: 'M11,3.5 L9.5,7.5 h3 z' }));
      ig.appendChild(s('polygon', { points: '5,12 9,12 7,10' }));
      // Override fill for the pans
      (ig.lastChild as SVGElement).setAttribute('fill', color);
      (ig.lastChild as SVGElement).setAttribute('opacity', '0.3');
      break;

    case 'sequence':
      // Stacked cards (deck)
      ig.appendChild(s('rect', { x: 3, y: 1, width: 9, height: 6, rx: 1 }));
      ig.appendChild(s('rect', { x: 1.5, y: 3.5, width: 9, height: 6, rx: 1 }));
      ig.appendChild(s('rect', { x: 0, y: 6, width: 9, height: 6, rx: 1 }));
      break;

    case 'component':
      // Chip with pins
      ig.appendChild(s('rect', { x: 3.5, y: 2, width: 7, height: 10, rx: 1 }));
      ig.appendChild(s('line', { x1: 1, y1: 5, x2: 3.5, y2: 5 }));
      ig.appendChild(s('line', { x1: 1, y1: 9, x2: 3.5, y2: 9 }));
      ig.appendChild(s('line', { x1: 10.5, y1: 5, x2: 13, y2: 5 }));
      ig.appendChild(s('line', { x1: 10.5, y1: 9, x2: 13, y2: 9 }));
      break;

    case 'object':
      // Document with folded corner
      ig.appendChild(s('path', { d: 'M2,1.5 h6.5 l3,3 v8 a1,1,0,0,1-1,1 h-8.5 a1,1,0,0,1-1-1 v-10 a1,1,0,0,1,1-1 z' }));
      ig.appendChild(s('path', { d: 'M8.5,1.5 v3 h3' }));
      break;

    default:
      // Generic: small square
      ig.appendChild(s('rect', { x: 2, y: 2, width: 10, height: 10, rx: 2 }));
      break;
  }

  g.appendChild(ig);
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
      // Square for export/imp
      const sq = attrs(el('rect'), {
        x: sx - PORT_R, y: py - PORT_R, width: PORT_R * 2, height: PORT_R * 2,
        rx: 1, fill: theme.accent, stroke: '#fff', 'stroke-width': 0.8,
      });
      const title = el('title') as SVGTitleElement;
      title.textContent = `${port.fieldName}: ${port.kind} #(${port.paramType})`;
      sq.appendChild(title);
      g.appendChild(sq);
    } else {
      // Circle for port
      const c = attrs(el('circle'), {
        cx: sx, cy: py, r: PORT_R,
        fill: theme.accent, stroke: '#fff', 'stroke-width': 0.8,
      });
      const title = el('title') as SVGTitleElement;
      title.textContent = `${port.fieldName}: ${port.kind} #(${port.paramType})`;
      c.appendChild(title);
      g.appendChild(c);
    }

    // Port label
    const lbl = attrs(el('text'), {
      x: sx, y: py + PORT_R + 9, 'text-anchor': 'middle', 'font-size': 7,
      fill: '#999', class: 'df-port-label',
    }) as SVGTextElement;
    lbl.textContent = port.fieldName.length > 10 ? port.fieldName.slice(0, 9) + '..' : port.fieldName;
    g.appendChild(lbl);

    sx += PORT_GAP;
  }
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

// ─── Connection arrows ────────────────────────────────────────
function drawConnections(parent: SVGGElement, roots: UvmDiagramNode[]): void {
  const all: { pNode: UvmDiagramNode; conn: TlmConnection }[] = [];
  const collect = (n: UvmDiagramNode) => {
    for (const c of n.connections) all.push({ pNode: n, conn: c });
    for (const ch of n.children) collect(ch);
  };
  for (const r of roots) collect(r);
  if (all.length === 0) return;

  const cg = el('g') as SVGGElement;
  cg.setAttribute('class', 'df-connections');

  for (const { pNode, conn } of all) {
    const src = findBlock(pNode, conn.from.split('.'));
    const dst = findBlock(pNode, conn.to.split('.'));
    if (src && dst && src !== dst) drawArrow(cg, src, dst);
  }
  parent.appendChild(cg);
}

function findBlock(parent: UvmDiagramNode, parts: string[]): BlockRect | undefined {
  if (parts.length < 1) return undefined;
  const name = parts[0];
  for (const ch of parent.children) {
    if (ch.className.toLowerCase().includes(name.toLowerCase()))
      return drawnBlocks.find(b => b.node.className === ch.className);
  }
  return drawnBlocks.find(b => b.node.className === name);
}

function drawArrow(parent: SVGGElement, from: BlockRect, to: BlockRect): void {
  const fcx = from.x + from.w / 2, fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2, tcy = to.y + to.h / 2;
  let x1: number, y1: number, x2: number, y2: number;

  if (Math.abs(fcx - tcx) > Math.abs(fcy - tcy)) {
    if (fcx < tcx) { x1 = from.x + from.w; y1 = fcy; x2 = to.x; y2 = tcy; }
    else { x1 = from.x; y1 = fcy; x2 = to.x + to.w; y2 = tcy; }
  } else {
    if (fcy < tcy) { x1 = fcx; y1 = from.y + from.h; x2 = tcx; y2 = to.y; }
    else { x1 = fcx; y1 = from.y; x2 = tcx; y2 = to.y + to.h; }
  }

  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const cx = Math.abs(y1 - y2) > Math.abs(x1 - x2) ? mx + 20 : mx;
  const cy = Math.abs(x1 - x2) > Math.abs(y1 - y2) ? my - 20 : my;

  parent.appendChild(attrs(el('path'), {
    d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`,
    class: 'df-arrow', 'marker-end': 'url(#ah)',
  }));
}

// ─── Legend ───────────────────────────────────────────────────
function drawLegend(parent: SVGGElement, x: number, y: number): void {
  const lg = el('g') as SVGGElement;
  lg.setAttribute('transform', `translate(${x},${y})`);
  lg.setAttribute('class', 'df-legend');

  const types = Object.keys(THEMES).filter(k => k !== 'unknown');
  const lh = types.length * 22 + 55;

  lg.appendChild(attrs(el('rect'), { x: 0, y: 0, width: 140, height: lh, rx: 6, fill: '#1a1a1a', stroke: '#444', 'stroke-width': 1, opacity: 0.9 }));

  const title = attrs(el('text'), { x: 10, y: 18, 'font-size': 11, 'font-weight': 'bold', fill: '#ccc' }) as SVGTextElement;
  title.textContent = 'Legend';
  lg.appendChild(title);

  // Port shapes
  lg.appendChild(attrs(el('circle'), { cx: 16, cy: 34, r: 4, fill: '#aaa', stroke: '#fff', 'stroke-width': 0.5 }));
  const pl = attrs(el('text'), { x: 26, y: 37, 'font-size': 9, fill: '#aaa' }) as SVGTextElement;
  pl.textContent = 'port';
  lg.appendChild(pl);
  lg.appendChild(attrs(el('rect'), { x: 66, y: 30, width: 8, height: 8, rx: 1, fill: '#aaa', stroke: '#fff', 'stroke-width': 0.5 }));
  const el2 = attrs(el('text'), { x: 80, y: 37, 'font-size': 9, fill: '#aaa' }) as SVGTextElement;
  el2.textContent = 'export';
  lg.appendChild(el2);

  let ly = 52;
  for (const t of types) {
    const th = THEMES[t];
    lg.appendChild(attrs(el('rect'), { x: 10, y: ly - 6, width: 14, height: 14, rx: 3, fill: th.fill, stroke: th.stroke, 'stroke-width': 1.5 }));
    const lb = attrs(el('text'), { x: 30, y: ly + 5, 'font-size': 10, fill: '#ccc' }) as SVGTextElement;
    lb.textContent = t;
    lg.appendChild(lb);
    ly += 22;
  }

  parent.appendChild(lg);
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
