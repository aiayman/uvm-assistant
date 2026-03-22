/**
 * UVM Block Diagram — simple nested rectangles view.
 * Shows component containment hierarchy without data flow details.
 */

interface UvmDiagramNode {
  className: string;
  uvmType: string;
  baseClass: string;
  filePath: string;
  line: number;
  children: UvmDiagramNode[];
}

const vscode = (window as any).acquireVsCodeApi();

// ─── Layout constants ─────────────────────────────────────────
const PADDING = 20;
const HEADER_H = 48;
const BLOCK_MIN_W = 150;
const BLOCK_MIN_H = 60;
const GAP = 16;
const LABEL_Y = 18;
const TYPE_Y = 34;
const CHAR_W = 7.8;

// ─── Color themes ─────────────────────────────────────────────
const COLORS: Record<string, { fill: string; stroke: string }> = {
  test:       { fill: '#1a3a2a', stroke: '#4ec9b0' },
  env:        { fill: '#1a2a3a', stroke: '#569cd6' },
  agent:      { fill: '#1a2a1a', stroke: '#6a9955' },
  driver:     { fill: '#2a2010', stroke: '#ce9178' },
  monitor:    { fill: '#2a2a10', stroke: '#dcdcaa' },
  sequencer:  { fill: '#2a1a2a', stroke: '#c586c0' },
  scoreboard: { fill: '#2a1515', stroke: '#d16969' },
  sequence:   { fill: '#152a2a', stroke: '#b5cea8' },
  component:  { fill: '#1a2a2a', stroke: '#9cdcfe' },
  object:     { fill: '#222',    stroke: '#888'    },
  unknown:    { fill: '#222',    stroke: '#666'    },
};

// ─── State ────────────────────────────────────────────────────
let svgEl: SVGSVGElement;
let rootG: SVGGElement;
let currentTransform = { x: 0, y: 0, k: 1 };

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  svgEl = document.getElementById('diagram') as unknown as SVGSVGElement;
  rootG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svgEl.appendChild(rootG);

  setupZoomPan();
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoom(1.2));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoom(0.8));
  document.getElementById('btn-reset')?.addEventListener('click', resetView);

  vscode.postMessage({ command: 'ready' });
});

// ─── Messages ─────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.data.command === 'renderDiagram') {
    render(event.data.data as UvmDiagramNode[]);
  }
});

// ─── Render ───────────────────────────────────────────────────
function render(roots: UvmDiagramNode[]): void {
  const emptyState = document.getElementById('empty-state')!;
  const container = document.getElementById('diagram-container')!;

  if (roots.length === 0) {
    emptyState.style.display = 'flex';
    container.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  container.style.display = 'block';

  while (rootG.firstChild) { rootG.removeChild(rootG.firstChild); }

  let offsetX = PADDING;
  for (const root of roots) {
    const size = measure(root);
    draw(rootG, root, offsetX, PADDING, size.w, size.h);
    offsetX += size.w + GAP;
  }
  resetView();
}

// ─── Measure ──────────────────────────────────────────────────
function measure(node: UvmDiagramNode): { w: number; h: number } {
  const textW = node.className.length * CHAR_W + PADDING * 2;

  if (node.children.length === 0) {
    return { w: Math.max(BLOCK_MIN_W, textW), h: BLOCK_MIN_H };
  }

  const sizes = node.children.map(c => measure(c));
  const totalW = sizes.reduce((s, c) => s + c.w, 0) + GAP * (sizes.length - 1);
  const maxH = Math.max(...sizes.map(c => c.h));

  return {
    w: Math.max(BLOCK_MIN_W, textW, totalW + PADDING * 2),
    h: Math.max(BLOCK_MIN_H, HEADER_H + maxH + PADDING * 2),
  };
}

// ─── Draw ─────────────────────────────────────────────────────
function draw(
  parent: SVGGElement, node: UvmDiagramNode,
  x: number, y: number, w: number, h: number,
): void {
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('transform', `translate(${x},${y})`);
  g.setAttribute('class', 'block');

  const theme = COLORS[node.uvmType] || COLORS.unknown;

  // Rectangle
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  rect.setAttribute('rx', '6');
  rect.setAttribute('fill', theme.fill);
  rect.setAttribute('stroke', theme.stroke);
  rect.setAttribute('stroke-width', '2');
  g.appendChild(rect);

  // Class name
  const label = document.createElementNS(ns, 'text');
  label.setAttribute('x', String(PADDING / 2));
  label.setAttribute('y', String(LABEL_Y));
  label.setAttribute('class', 'block-label');
  label.textContent = node.className;
  g.appendChild(label);

  // Type badge
  const badge = document.createElementNS(ns, 'text');
  badge.setAttribute('x', String(PADDING / 2));
  badge.setAttribute('y', String(TYPE_Y));
  badge.setAttribute('class', 'block-type');
  badge.textContent = `[${node.uvmType}]`;
  g.appendChild(badge);

  // Click to open file
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'openFile', filePath: node.filePath, line: node.line });
  });

  // Children
  if (node.children.length > 0) {
    const sizes = node.children.map(c => measure(c));
    let cx = PADDING;
    const cy = HEADER_H;
    for (let i = 0; i < node.children.length; i++) {
      draw(g, node.children[i], cx, cy, sizes[i].w, sizes[i].h);
      cx += sizes[i].w + GAP;
    }
  }

  parent.appendChild(g);
}

// ─── Zoom / Pan ──────────────────────────────────────────────
function setupZoomPan(): void {
  let panning = false, sx = 0, sy = 0;

  svgEl.addEventListener('mousedown', (e) => {
    if (e.button === 0) { panning = true; sx = e.clientX - currentTransform.x; sy = e.clientY - currentTransform.y; }
  });
  document.addEventListener('mousemove', (e) => {
    if (!panning) return;
    currentTransform.x = e.clientX - sx;
    currentTransform.y = e.clientY - sy;
    applyTransform();
  });
  document.addEventListener('mouseup', () => { panning = false; });
  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svgEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
}

function zoom(f: number): void {
  const r = svgEl.getBoundingClientRect();
  zoomAt(f, r.width / 2, r.height / 2);
}

function zoomAt(f: number, cx: number, cy: number): void {
  const nk = Math.max(0.1, Math.min(5, currentTransform.k * f));
  const ratio = nk / currentTransform.k;
  currentTransform.x = cx - ratio * (cx - currentTransform.x);
  currentTransform.y = cy - ratio * (cy - currentTransform.y);
  currentTransform.k = nk;
  applyTransform();
}

function resetView(): void {
  currentTransform = { x: 20, y: 20, k: 1 };
  applyTransform();
}

function applyTransform(): void {
  rootG.setAttribute('transform',
    `translate(${currentTransform.x},${currentTransform.y}) scale(${currentTransform.k})`);
}

export {};
