/**
 * UVM Block Diagram — D3.js rendering logic (runs inside VS Code webview).
 *
 * Receives UVM hierarchy JSON from the extension via postMessage and renders
 * nested rectangles representing UVM environments, agents, drivers, monitors,
 * sequencers, scoreboards, and sequences.
 */

interface UvmDiagramNode {
  className: string;
  uvmType: string;
  baseClass: string;
  filePath: string;
  line: number;
  children: UvmDiagramNode[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Acquire VS Code API
const vscode = (window as any).acquireVsCodeApi();

// ─── Layout constants ─────────────────────────────────────────
const PADDING = 20;
const HEADER_H = 48;
const BLOCK_MIN_W = 140;
const BLOCK_MIN_H = 60;
const GAP = 16;
const LABEL_OFFSET_Y = 18;
const TYPE_OFFSET_Y = 34;
const CHAR_WIDTH = 7.8; // approximate px per character at 13px font

// ─── State ────────────────────────────────────────────────────
let svgEl: SVGSVGElement;
let rootG: SVGGElement;
let currentData: UvmDiagramNode[] = [];
let currentTransform = { x: 0, y: 0, k: 1 };

// ─── Initialise ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  svgEl = document.getElementById('diagram') as unknown as SVGSVGElement;
  rootG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svgEl.appendChild(rootG);

  // Zoom / pan with mouse
  setupZoomPan();

  // Toolbar buttons
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoom(1.2));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoom(0.8));
  document.getElementById('btn-reset')?.addEventListener('click', resetView);

  // Notify the extension that the webview is ready to receive messages
  vscode.postMessage({ command: 'ready' });
});

// ─── Message handler ──────────────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.command === 'renderDiagram') {
    currentData = msg.data as UvmDiagramNode[];
    render(currentData);
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

  // Clear previous
  while (rootG.firstChild) {
    rootG.removeChild(rootG.firstChild);
  }

  // Layout: place roots side by side
  let offsetX = PADDING;
  for (const root of roots) {
    const size = measureNode(root);
    drawNode(rootG, root, offsetX, PADDING, size.w, size.h);
    offsetX += size.w + GAP;
  }

  // Reset view to fit
  resetView();
}

// ─── Measure (recursive) ─────────────────────────────────────

/** Estimate the minimum width needed for the block's header text. */
function estimateTextWidth(node: UvmDiagramNode): number {
  const nameW = node.className.length * CHAR_WIDTH;
  const typeW = (node.uvmType.length + 2) * (CHAR_WIDTH * 0.77); // type badge is 10px font
  return Math.max(nameW, typeW) + PADDING * 2;
}

function measureNode(node: UvmDiagramNode): { w: number; h: number } {
  const textW = estimateTextWidth(node);

  if (node.children.length === 0) {
    return { w: Math.max(BLOCK_MIN_W, textW), h: BLOCK_MIN_H };
  }

  const childSizes = node.children.map((c) => measureNode(c));

  // Layout children in a row inside the parent
  const totalChildW = childSizes.reduce((sum, s) => sum + s.w, 0) + GAP * (childSizes.length - 1);
  const maxChildH = Math.max(...childSizes.map((s) => s.h));

  const w = Math.max(BLOCK_MIN_W, textW, totalChildW + PADDING * 2);
  const h = Math.max(BLOCK_MIN_H, HEADER_H + maxChildH + PADDING * 2);

  return { w, h };
}

// ─── Draw (recursive) ────────────────────────────────────────
function drawNode(
  parent: SVGGElement,
  node: UvmDiagramNode,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', `uvm-block block-${node.uvmType}`);
  g.setAttribute('transform', `translate(${x},${y})`);

  // Background rect
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  g.appendChild(rect);

  // Class name label
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', String(PADDING / 2));
  label.setAttribute('y', String(LABEL_OFFSET_Y));
  label.setAttribute('class', 'block-label');
  label.textContent = node.className;
  g.appendChild(label);

  // Type badge (second line, below class name)
  const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  badge.setAttribute('x', String(PADDING / 2));
  badge.setAttribute('y', String(TYPE_OFFSET_Y));
  badge.setAttribute('class', 'block-type');
  badge.textContent = `[${node.uvmType}]`;
  g.appendChild(badge);

  // Click to open file
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({
      command: 'openFile',
      filePath: node.filePath,
      line: node.line,
    });
  });

  // Draw children inside
  if (node.children.length > 0) {
    const childSizes = node.children.map((c) => measureNode(c));
    let childX = PADDING;
    const childY = HEADER_H + PADDING / 2;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const cs = childSizes[i];
      drawNode(g, child, childX, childY, cs.w, cs.h);
      childX += cs.w + GAP;
    }
  }

  parent.appendChild(g);
}

// ─── Zoom / Pan ──────────────────────────────────────────────
function setupZoomPan(): void {
  let isPanning = false;
  let startX = 0;
  let startY = 0;

  svgEl.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      isPanning = true;
      startX = e.clientX - currentTransform.x;
      startY = e.clientY - currentTransform.y;
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) { return; }
    currentTransform.x = e.clientX - startX;
    currentTransform.y = e.clientY - startY;
    applyTransform();
  });

  document.addEventListener('mouseup', () => {
    isPanning = false;
  });

  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = svgEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    zoomAt(factor, mx, my);
  }, { passive: false });
}

function zoom(factor: number): void {
  const rect = svgEl.getBoundingClientRect();
  zoomAt(factor, rect.width / 2, rect.height / 2);
}

function zoomAt(factor: number, cx: number, cy: number): void {
  const newK = Math.max(0.1, Math.min(5, currentTransform.k * factor));
  const ratio = newK / currentTransform.k;
  currentTransform.x = cx - ratio * (cx - currentTransform.x);
  currentTransform.y = cy - ratio * (cy - currentTransform.y);
  currentTransform.k = newK;
  applyTransform();
}

function resetView(): void {
  currentTransform = { x: 20, y: 20, k: 1 };
  applyTransform();
}

function applyTransform(): void {
  rootG.setAttribute(
    'transform',
    `translate(${currentTransform.x},${currentTransform.y}) scale(${currentTransform.k})`,
  );
}
