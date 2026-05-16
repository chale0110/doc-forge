/**
 * DocForge — PDF Editor (Continuous Scroll + Annotation)
 *
 * Architecture:
 *  — All pages rendered as stacked canvases in a scroll container.
 *  — Scroll position → editorCurrentPage.
 *  — Ctrl+wheel → zoom (scale all canvases).  Plain wheel → native scroll.
 *  — Annotations (highlights / rects / text edits) are per-page.
 *  — Eraser tool deletes annotations without affecting original PDF.
 */

/* ──────────────────────────────────────────────────────────
   pdf.js worker
   ────────────────────────────────────────────────────────── */
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ──────────────────────────────────────────────────────────
   Global State
   ────────────────────────────────────────────────────────── */
let editorPdfDoc    = null;
let editorFileId    = null;
let editorTotalPages = 0;
let editorScale     = 1.5;
let editorTool      = 'select';
let editorCurrentPage = 0;          // determined by scroll position

// pageStates[pageNum] = { textBlocks, highlights, rectAnnots, edits, rendered, canvas }
let pageStates      = [];

let _hlIdCounter = 0;
let _rectIdCounter = 0;

// Drag state
let _isDragging     = false;
let _dragMode       = null;       // 'draw' | 'move' | 'resize' | 'highlight-select'
let _dragHandle     = null;
let _dragStart      = { mx:0, my:0 };
let _dragRectSnap   = null;
let _dragPage       = -1;
let _selRectPage    = -1;
let _selRectIdx     = -1;
let _selHlPage      = -1;
let _selHlIdx       = -1;

// Scroll tracking (throttle)
let _scrollTicking  = false;
let _pendingRender  = new Set();   // page numbers that need rendering

/* ──────────────────────────────────────────────────────────
   Load PDF — create all page wrappers WITH correct dimensions
   ────────────────────────────────────────────────────────── */
async function loadEditorPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  editorPdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  editorTotalPages = editorPdfDoc.numPages;

  const uploadResult = await api.upload([file]);
  if (uploadResult.files?.length > 0) {
    editorFileId = uploadResult.files[0].id;
    STATE.editorFile = uploadResult.files[0];
  }

  // Reset state
  pageStates = [];
  for (let i = 0; i < editorTotalPages; i++) {
    pageStates.push({
      textBlocks: [],
      highlights: [],
      rectAnnots: [],
      edits: [],
      rendered: false,
      canvas: null,
      pageWidth: 595,  // defaults, real values set below
      pageHeight: 842,
    });
  }

  document.getElementById('editor-toolbar').classList.remove('hidden');
  document.getElementById('editor-fill').style.display = 'none';

  // Pre-fetch all page dimensions, build DOM with correct sizes
  await buildPageDOM();
  // Render sidebar thumbnails
  renderThumbList();
  // Now render visible pages (much faster since DOM has correct spacing)
  await renderVisiblePages();

  setupScrollTracking();
  setupGlobalZoom();

  updateZoomDisplay();
  updatePageInfo();
  document.querySelector('.thumb-item')?.classList.add('active');
}

function handleEditorDrop(files) {
  const pdfs = Array.from(files).filter(f =>
    f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf'
  );
  if (pdfs.length > 0) loadEditorPdf(pdfs[0]);
}

/* ──────────────────────────────────────────────────────────
   Page DOM — pre-fetch all page viewports so every wrapper
   has correct dimensions BEFORE any render call.
   ────────────────────────────────────────────────────────── */
async function buildPageDOM() {
  const container = document.getElementById('pages-container');
  container.innerHTML = '';

  for (let i = 0; i < editorTotalPages; i++) {
    // Get this page's viewport (fast — metadata only, no render)
    const page = await editorPdfDoc.getPage(i + 1);
    const vp = page.getViewport({ scale: editorScale });
    const w = vp.width, h = vp.height;

    pageStates[i].pageWidth = w;
    pageStates[i].pageHeight = h;

    // Wrapper ensures scroll layout space even before rendering
    const wrap = document.createElement('div');
    wrap.className = 'page-wrapper';
    wrap.dataset.page = i;
    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';

    const canvas = document.createElement('canvas');
    canvas.id = 'page-canvas-' + i;
    canvas.className = 'page-canvas';
    canvas.width = w;
    canvas.height = h;
    wrap.appendChild(canvas);

    const label = document.createElement('div');
    label.className = 'page-num-label';
    label.textContent = '第 ' + (i + 1) + ' 页';
    wrap.appendChild(label);

    container.appendChild(wrap);
    pageStates[i].canvas = canvas;
  }
}

/* ──────────────────────────────────────────────────────────
   Render visible pages (+ buffer 1 page above/below)
   ────────────────────────────────────────────────────────── */
async function renderVisiblePages() {
  if (!editorPdfDoc) return;

  const container = document.getElementById('editor-canvas-container');
  const containerTop = container.scrollTop;
  const containerHeight = container.clientHeight;

  // Determine which page is center-most → editorCurrentPage
  let bestPage = editorCurrentPage;
  let bestDist = Infinity;
  for (let i = 0; i < editorTotalPages; i++) {
    const canvas = pageStates[i].canvas;
    if (!canvas) continue;
    const rect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const pageCenter = rect.top + rect.height / 2 - containerRect.top;
    const viewCenter = containerHeight / 2;
    const dist = Math.abs(pageCenter - viewCenter);
    if (dist < bestDist) { bestDist = dist; bestPage = i; }
  }
  if (bestPage !== editorCurrentPage) {
    editorCurrentPage = bestPage;
    updatePageInfo();
    updateThumbHighlight();
  }

  // Render pages that are near the viewport
  for (let i = 0; i < editorTotalPages; i++) {
    const canvas = pageStates[i].canvas;
    if (!canvas) continue;
    const rect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const visible = (rect.bottom > containerRect.top && rect.top < containerRect.bottom);

    if (visible && !pageStates[i].rendered) {
      await renderSinglePage(i);
    }
  }
}

// ── Background cache for smooth drag preview ──────────────
function _initBgCache(pageNum, w, h) {
  if (!pageStates[pageNum]._bgCanvas) {
    pageStates[pageNum]._bgCanvas = document.createElement('canvas');
  }
  pageStates[pageNum]._bgCanvas.width = w;
  pageStates[pageNum]._bgCanvas.height = h;
}

function _drawOverlaysToCtx(pageNum, ctx) {
  const ps = pageStates[pageNum];
  const vp = { width: ps.pageWidth, height: ps.pageHeight };
  drawTextBlockOverlays(pageNum, ctx, vp);
  drawAllRectAnnots(pageNum, ctx, vp);
  drawAllHighlights(pageNum, ctx, vp);
}

async function renderSinglePage(pageNum, skipOverlays = false) {
  const canvas = pageStates[pageNum].canvas;
  if (!canvas || !editorPdfDoc) return;

  const page = await editorPdfDoc.getPage(pageNum + 1);
  const viewport = page.getViewport({ scale: editorScale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Cache PDF background (without overlays) for smooth drag preview
  _initBgCache(pageNum, viewport.width, viewport.height);
  const bgCanvas = pageStates[pageNum]._bgCanvas;
  bgCanvas.getContext('2d').drawImage(canvas, 0, 0);

  // Fetch text structure (only on first render or after zoom)
  if (!pageStates[pageNum].textBlocks || pageStates[pageNum].textBlocks.length === 0) {
    try {
      const data = await api.pdfParse(editorFileId, pageNum);
      pageStates[pageNum].textBlocks = data.text_blocks || [];
    } catch (e) { /* ignore */ }
  }

  // Draw overlays
  _drawOverlaysToCtx(pageNum, ctx);

  pageStates[pageNum].rendered = true;

  // Setup canvas interaction
  setupCanvasInteraction(canvas, pageNum, viewport);
}

// ── Fast redraw (no PDF re-render — uses cached background) ──
function fastRedrawWithOverlays(pageNum) {
  const canvas = pageStates[pageNum].canvas;
  const bg = pageStates[pageNum]._bgCanvas;
  if (!canvas || !bg) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bg, 0, 0);  // PDF background (cached)
  _drawOverlaysToCtx(pageNum, ctx);  // all annotations on top
}

/* ──────────────────────────────────────────────────────────
   Re-render all rendered pages (used after zoom / edit)
   ────────────────────────────────────────────────────────── */
async function reRenderAll() {
  for (let i = 0; i < editorTotalPages; i++) {
    if (pageStates[i].rendered) {
      await renderSinglePage(i);
    }
  }
  // Also re-render visible non-rendered pages
  await renderVisiblePages();
}

/* ──────────────────────────────────────────────────────────
   Scroll Tracking
   ────────────────────────────────────────────────────────── */
function setupScrollTracking() {
  const container = document.getElementById('editor-canvas-container');
  container.addEventListener('scroll', () => {
    if (!_scrollTicking) {
      requestAnimationFrame(() => {
        renderVisiblePages();
        _scrollTicking = false;
      });
      _scrollTicking = true;
    }
  }, { passive: true });
}

function updatePageInfo() {
  document.getElementById('editor-page-info').textContent =
    `第 ${editorCurrentPage + 1} / ${editorTotalPages} 页`;
}

function updateThumbHighlight() {
  document.querySelectorAll('.thumb-item').forEach((el, i) => {
    el.classList.toggle('active', i === editorCurrentPage);
  });
}

/* ──────────────────────────────────────────────────────────
   Global Zoom (Ctrl+wheel → zoom all pages)
   ────────────────────────────────────────────────────────── */
function setupGlobalZoom() {
  const old = document._docForgeZoomHandler;
  if (old) document.removeEventListener('wheel', old, true);

  const handler = (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const container = document.getElementById('editor-canvas-container');
      const scrollTop = container.scrollTop;
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const oldScale = editorScale;
      editorScale = Math.max(0.3, Math.min(4.0, editorScale + delta));
      const ratio = editorScale / oldScale;

      // 1) Resize all canvas elements and wrappers to new scale
      resizeAllPages().then(() => {
        // 2) Re-render visible pages at new scale
        return renderVisiblePages();
      }).then(() => {
        // 3) Restore scroll position proportionally
        container.scrollTop = scrollTop * ratio;
      });

      updateZoomDisplay();
    }
    // Without Ctrl: let natural scroll happen
  };
  document.addEventListener('wheel', handler, { passive: false, capture: true });
  document._docForgeZoomHandler = handler;
}

// ── Resize all page canvases & wrappers after scale change ──
async function resizeAllPages() {
  for (let i = 0; i < editorTotalPages; i++) {
    const page = await editorPdfDoc.getPage(i + 1);
    const vp = page.getViewport({ scale: editorScale });
    const w = vp.width, h = vp.height;

    pageStates[i].pageWidth = w;
    pageStates[i].pageHeight = h;
    pageStates[i].rendered = false;   // force re-render
    pageStates[i]._bgCanvas = null;   // invalidate cache

    const canvas = pageStates[i].canvas;
    if (canvas) {
      canvas.width = w;
      canvas.height = h;
      const wrap = canvas.parentElement;
      if (wrap) {
        wrap.style.width = w + 'px';
        wrap.style.height = h + 'px';
      }
    }
  }
}

function updateZoomDisplay() {
  const el = document.getElementById('editor-zoom-pct');
  if (el) el.textContent = Math.round(editorScale * 100) + '%';
}

/* ──────────────────────────────────────────────────────────
   Text Block Overlays
   ────────────────────────────────────────────────────────── */
function drawTextBlockOverlays(pageNum, ctx, viewport) {
  const blocks = pageStates[pageNum].textBlocks;
  const s = editorScale;
  blocks.forEach(block => {
    const x = block.x * s;
    const y = block.y * s;
    const w = block.width * s;
    const h = block.height * s;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 122, 255, 0.25)';
    ctx.lineWidth = 0.75;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.restore();
  });
}

/* ──────────────────────────────────────────────────────────
   Rect Annotations
   ────────────────────────────────────────────────────────── */
function drawAllRectAnnots(pageNum, ctx, viewport) {
  pageStates[pageNum].rectAnnots.forEach((ra, i) => {
    const isSel = (pageNum === _selRectPage && i === _selRectIdx);
    drawSingleRect(ctx, ra, isSel);
  });
}

function drawSingleRect(ctx, ra, isSelected) {
  ctx.save();
  if (ra.fill && ra.fill !== 'none') {
    const alpha = (ra.opacity !== undefined) ? ra.opacity / 100 : 1.0;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ra.fill;
    ctx.fillRect(ra.x, ra.y, ra.w, ra.h);
    ctx.globalAlpha = 1.0;
  }
  ctx.strokeStyle = ra.color || '#ff3b30';
  ctx.lineWidth = isSelected ? 2 : 1.5;
  ctx.strokeRect(ra.x, ra.y, ra.w, ra.h);

  if (isSelected) {
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = '#007aff';
    ctx.lineWidth = 1;
    ctx.strokeRect(ra.x, ra.y, ra.w, ra.h);
    ctx.setLineDash([]);
    drawHandle(ctx, ra.x, ra.y);
    drawHandle(ctx, ra.x + ra.w, ra.y);
    drawHandle(ctx, ra.x, ra.y + ra.h);
    drawHandle(ctx, ra.x + ra.w, ra.y + ra.h);
    drawHandle(ctx, ra.x + ra.w / 2, ra.y);
    drawHandle(ctx, ra.x + ra.w / 2, ra.y + ra.h);
    drawHandle(ctx, ra.x, ra.y + ra.h / 2);
    drawHandle(ctx, ra.x + ra.w, ra.y + ra.h / 2);
  }
  ctx.restore();
}

function drawHandle(ctx, cx, cy) {
  const s = 4;
  ctx.fillStyle = 'white';
  ctx.strokeStyle = '#007aff';
  ctx.lineWidth = 1.5;
  ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
  ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
}

/* ──────────────────────────────────────────────────────────
   Highlights
   ────────────────────────────────────────────────────────── */
function drawAllHighlights(pageNum, ctx, viewport) {
  const s = editorScale;
  pageStates[pageNum].highlights.forEach((hl, i) => {
    const x = hl.x * s;
    const y = hl.y * s;
    const w = hl.width * s;
    const h = hl.height * s;

    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = hl.color || '#FFD700';
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1.0;

    if (pageNum === _selHlPage && i === _selHlIdx) {
      ctx.strokeStyle = '#007aff';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
      ctx.setLineDash([]);
    }
    ctx.restore();
  });
}

/* ──────────────────────────────────────────────────────────
   Canvas Interaction (setup per-page)
   ────────────────────────────────────────────────────────── */
function setupCanvasInteraction(canvas, pageNum, viewport) {
  const s = editorScale;  // canvas = PDF-point × s

  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      mx: (e.clientX - rect.left) * (canvas.width / rect.width),
      my: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // ── Click ──
  canvas.onclick = (e) => {
    if (_isDragging) return;
    const { mx, my } = getMousePos(e);
    if (editorTool === 'text') {
      const text = prompt('输入文字:');
      if (!text) return;
      const color = document.getElementById('editor-color')?.value || '#000000';
      pageStates[pageNum].edits.push({
        type: 'add_text', page: pageNum,
        x: mx, y: my, text, size: 14, color,
      });
      const ctx = canvas.getContext('2d');
      ctx.font = '14px sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(text, mx, my);
      return;
    }
    if (editorTool === 'eraser') {
      handleEraser(pageNum, mx, my);
      return;
    }
    if (editorTool === 'select') {
      handleSelectClick(pageNum, mx, my);
    }
  };

  // ── Mousedown ──
  canvas.onmousedown = (e) => {
    if (editorTool !== 'rect' && editorTool !== 'highlight' && editorTool !== 'select') return;
    const { mx, my } = getMousePos(e);
    _dragPage = pageNum;

    if (editorTool === 'highlight') {
      _isDragging = true;
      _dragMode = 'highlight-select';
      _dragStart = { mx, my };
      return;
    }
    if (editorTool === 'rect') {
      _isDragging = true;
      _dragMode = 'draw';
      _dragStart = { mx, my };
      return;
    }
    if (editorTool === 'select') {
      // Check resize handles on selected rect
      if (_selRectPage === pageNum && _selRectIdx >= 0) {
        const ra = pageStates[pageNum].rectAnnots[_selRectIdx];
        const h = hitTestHandle(ra, mx, my);
        if (h) {
          _isDragging = true;
          _dragMode = 'resize';
          _dragHandle = h;
          _dragStart = { mx, my };
          _dragRectSnap = { ...ra };
          return;
        }
      }
      // Check rect hit for move
      const rects = pageStates[pageNum].rectAnnots;
      for (let i = rects.length - 1; i >= 0; i--) {
        const ra = rects[i];
        if (mx >= ra.x && mx <= ra.x + ra.w && my >= ra.y && my <= ra.y + ra.h) {
          _selRectPage = pageNum;
          _selRectIdx = i;
          _selHlPage = -1;
          _selHlIdx = -1;
          _isDragging = true;
          _dragMode = 'move';
          _dragStart = { mx, my };
          _dragRectSnap = { ...ra };
          renderSinglePage(pageNum);
          return;
        }
      }
      // Check highlight hit
      const hls = pageStates[pageNum].highlights;
      for (let i = hls.length - 1; i >= 0; i--) {
        const hl = hls[i];
        const hx = hl.x * s, hy = hl.y * s, hw = hl.width * s, hh = hl.height * s;
        if (mx >= hx && mx <= hx + hw && my >= hy && my <= hy + hh) {
          _selHlPage = pageNum;
          _selHlIdx = i;
          _selRectPage = -1;
          _selRectIdx = -1;
          showHighlightPropsPopover(hl, pageNum, i);
          renderSinglePage(pageNum);
          return;
        }
      }
      // Deselect
      _selRectPage = _selRectIdx = _selHlPage = _selHlIdx = -1;
      hideAllPopovers();
      renderSinglePage(pageNum);
    }
  };

  // ── Mousemove (only on this canvas) ──
  canvas.onmousemove = (e) => {
    if (!_isDragging || _dragPage !== pageNum) return;
    const { mx, my } = getMousePos(e);

    if (_dragMode === 'draw') {
      const rx = Math.min(_dragStart.mx, mx), ry = Math.min(_dragStart.my, my);
      const rw = Math.abs(mx - _dragStart.mx), rh = Math.abs(my - _dragStart.my);
      redrawWithTempRect(pageNum, rx, ry, rw, rh);
    } else if (_dragMode === 'highlight-select') {
      redrawWithTempHighlight(pageNum, _dragStart.mx, _dragStart.my, mx, my);
    } else if (_dragMode === 'move' && _selRectPage === pageNum && _selRectIdx >= 0) {
      const dx = mx - _dragStart.mx, dy = my - _dragStart.my;
      const ra = pageStates[pageNum].rectAnnots[_selRectIdx];
      ra.x = _dragRectSnap.x + dx;
      ra.y = _dragRectSnap.y + dy;
      renderSinglePage(pageNum);
    } else if (_dragMode === 'resize' && _selRectPage === pageNum && _selRectIdx >= 0) {
      doResize(pageNum, mx, my);
    }
  };

  // ── Mouseup ──
  canvas.onmouseup = (e) => {
    if (!_isDragging || _dragPage !== pageNum) return;

    if (_dragMode === 'highlight-select') {
      const { mx, my } = getMousePos(e);
      const rx = Math.min(_dragStart.mx, mx), ry = Math.min(_dragStart.my, my);
      const rw = Math.abs(mx - _dragStart.mx), rh = Math.abs(my - _dragStart.my);
      if (rw > 3 && rh > 3) {
        highlightBlocksInRect(pageNum, rx, ry, rw, rh);
      } else {
        handleHighlightClick(pageNum, _dragStart.mx, _dragStart.my);
      }
    } else if (_dragMode === 'draw') {
      const { mx, my } = getMousePos(e);
      const rx = Math.min(_dragStart.mx, mx), ry = Math.min(_dragStart.my, my);
      const rw = Math.abs(mx - _dragStart.mx), rh = Math.abs(my - _dragStart.my);
      if (rw > 5 && rh > 5) {
        const color = document.getElementById('editor-color')?.value || '#ff3b30';
        const fill = document.getElementById('editor-fill')?.value || 'rgba(255,255,255,0.5)';
        const nr = { id: 'r_' + (++_rectIdCounter), x: rx, y: ry, w: rw, h: rh, color, fill, opacity: 60 };
        pageStates[pageNum].rectAnnots.push(nr);
        _selRectPage = pageNum;
        _selRectIdx = pageStates[pageNum].rectAnnots.length - 1;
        _selHlPage = _selHlIdx = -1;
        showRectPropsPopover(nr, pageNum, _selRectIdx);
      }
    }

    _isDragging = false;
    _dragMode = null;
    _dragHandle = null;
    _dragPage = -1;
    if (_dragMode !== 'draw' || true) {
      renderSinglePage(pageNum);
    }
  };

  // ── Double-click highlight → popover ──
  canvas.ondblclick = (e) => {
    const { mx, my } = getMousePos(e);
    const hls = pageStates[pageNum].highlights;
    for (let i = hls.length - 1; i >= 0; i--) {
      const hl = hls[i];
      if (mx >= hl.x * s && mx <= (hl.x + hl.width) * s &&
          my >= hl.y * s && my <= (hl.y + hl.height) * s) {
        _selHlPage = pageNum;
        _selHlIdx = i;
        showHighlightPropsPopover(hl, pageNum, i);
        return;
      }
    }
  };
}

/* ──────────────────────────────────────────────────────────
   Highlight: blocks in rect
   ────────────────────────────────────────────────────────── */
function highlightBlocksInRect(pageNum, rx, ry, rw, rh) {
  const blocks = pageStates[pageNum].textBlocks;
  const s = editorScale;
  // Mouse coords are in canvas space. Text blocks in PDF space.
  // Convert selection rect → PDF space
  const prx = rx / s, pry = ry / s, prw = rw / s, prh = rh / s;

  const color = document.getElementById('editor-color')?.value || '#FFD700';
  const highlights = pageStates[pageNum].highlights;

  blocks.forEach(block => {
    if (prx < block.x + block.width && prx + prw > block.x &&
        pry < block.y + block.height && pry + prh > block.y) {
      if (!highlights.find(h => h.blockId === block.id)) {
        highlights.push({
          id: 'hl_' + (++_hlIdCounter),
          blockId: block.id,
          color,
          x: block.x, y: block.y,
          width: block.width, height: block.height,
        });
      }
    }
  });
}

function handleHighlightClick(pageNum, mx, my) {
  const blocks = pageStates[pageNum].textBlocks;
  const highlights = pageStates[pageNum].highlights;
  const s = editorScale;

  for (const block of blocks) {
    const bx = block.x * s, by = block.y * s, bw = block.width * s, bh = block.height * s;
    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      const idx = highlights.findIndex(h => h.blockId === block.id);
      if (idx >= 0) {
        highlights.splice(idx, 1); // toggle off
      } else {
        const color = document.getElementById('editor-color')?.value || '#FFD700';
        highlights.push({
          id: 'hl_' + (++_hlIdCounter),
          blockId: block.id,
          color,
          x: block.x, y: block.y,
          width: block.width, height: block.height,
        });
      }
      return;
    }
  }
}

/* ──────────────────────────────────────────────────────────
   Select / Eraser
   ────────────────────────────────────────────────────────── */
function handleSelectClick(pageNum, mx, my) {
  const s = editorScale;
  // Highlight hit
  const hls = pageStates[pageNum].highlights;
  for (let i = hls.length - 1; i >= 0; i--) {
    const hl = hls[i];
    if (mx >= hl.x * s && mx <= (hl.x + hl.width) * s &&
        my >= hl.y * s && my <= (hl.y + hl.height) * s) {
      _selHlPage = pageNum;
      _selHlIdx = i;
      showHighlightPropsPopover(hl, pageNum, i);
      return;
    }
  }
  // Text block hit
  for (const block of pageStates[pageNum].textBlocks) {
    const bx = block.x * s, by = block.y * s, bw = block.width * s, bh = block.height * s;
    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      showTextEditPopover(block, pageNum);
      return;
    }
  }
  hideAllPopovers();
}

function handleEraser(pageNum, mx, my) {
  const s = editorScale;
  // Highlights
  const hls = pageStates[pageNum].highlights;
  for (let i = hls.length - 1; i >= 0; i--) {
    const hl = hls[i];
    if (mx >= hl.x * s && mx <= (hl.x + hl.width) * s &&
        my >= hl.y * s && my <= (hl.y + hl.height) * s) {
      hls.splice(i, 1);
      _selHlPage = _selHlIdx = -1;
      renderSinglePage(pageNum);
      return;
    }
  }
  // Text blocks
  for (const block of pageStates[pageNum].textBlocks) {
    const bx = block.x * s, by = block.y * s, bw = block.width * s, bh = block.height * s;
    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      pageStates[pageNum].edits.push({
        type: 'text', page: pageNum,
        block_id: block.id, x: block.x, y: block.y,
        width: block.width, height: block.height,
        new_text: '', size: block.size,
      });
      renderSinglePage(pageNum);
      return;
    }
  }
  // Rects
  const rects = pageStates[pageNum].rectAnnots;
  for (let i = rects.length - 1; i >= 0; i--) {
    const ra = rects[i];
    if (mx >= ra.x && mx <= ra.x + ra.w && my >= ra.y && my <= ra.y + ra.h) {
      rects.splice(i, 1);
      _selRectPage = _selRectIdx = -1;
      renderSinglePage(pageNum);
      return;
    }
  }
}

/* ──────────────────────────────────────────────────────────
   Resize / Handle test
   ────────────────────────────────────────────────────────── */
function hitTestHandle(ra, mx, my) {
  const pts = {
    nw:[ra.x, ra.y], ne:[ra.x+ra.w, ra.y],
    sw:[ra.x, ra.y+ra.h], se:[ra.x+ra.w, ra.y+ra.h],
    n:[ra.x+ra.w/2, ra.y], s:[ra.x+ra.w/2, ra.y+ra.h],
    e:[ra.x+ra.w, ra.y+ra.h/2], w:[ra.x, ra.y+ra.h/2],
  };
  const hs = 8;
  for (const [k, [cx, cy]] of Object.entries(pts)) {
    if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return k;
  }
  return null;
}

function doResize(pageNum, mx, my) {
  const ra = pageStates[pageNum].rectAnnots[_selRectIdx];
  if (!ra || !_dragRectSnap) return;
  const s = _dragRectSnap;
  let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
  switch (_dragHandle) {
    case 'nw': nx = mx; ny = my; nw = s.x+s.w-mx; nh = s.y+s.h-my; break;
    case 'ne': ny = my; nw = mx-s.x; nh = s.y+s.h-my; break;
    case 'sw': nx = mx; nw = s.x+s.w-mx; nh = my-s.y; break;
    case 'se': nw = mx-s.x; nh = my-s.y; break;
    case 'n':  ny = my; nh = s.y+s.h-my; break;
    case 's':  nh = my-s.y; break;
    case 'e':  nw = mx-s.x; break;
    case 'w':  nx = mx; nw = s.x+s.w-mx; break;
  }
  if (nw < 10) { nw = 10; nx = (mx < s.x) ? s.x : s.x+s.w-10; }
  if (nh < 10) { nh = 10; ny = (my < s.y) ? s.y : s.y+s.h-10; }
  ra.x = nx; ra.y = ny; ra.w = nw; ra.h = nh;
  renderSinglePage(pageNum);
}

/* ──────────────────────────────────────────────────────────
   Live preview helpers — use cached bg, no PDF re-render
   ────────────────────────────────────────────────────────── */
function redrawWithTempRect(pageNum, rx, ry, rw, rh) {
  fastRedrawWithOverlays(pageNum);
  const canvas = pageStates[pageNum].canvas;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.setLineDash([]);
  ctx.restore();
}

function redrawWithTempHighlight(pageNum, x1, y1, x2, y2) {
  fastRedrawWithOverlays(pageNum);
  const canvas = pageStates[pageNum].canvas;
  const ctx = canvas.getContext('2d');
  const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
  const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
  ctx.save();
  ctx.fillStyle = 'rgba(0,120,255,0.2)';
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = 'rgba(0,120,255,0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.setLineDash([]);
  ctx.restore();
}

/* ──────────────────────────────────────────────────────────
   Popovers
   ────────────────────────────────────────────────────────── */
function showHighlightPropsPopover(hl, pageNum, idx) {
  const popup = document.getElementById('highlight-props-popup');
  popup.classList.remove('hidden');

  const canvas = document.getElementById('page-canvas-' + pageNum);
  const cr = canvas.getBoundingClientRect();
  popup.style.left = Math.min(cr.right - 260, cr.left + 40) + 'px';
  popup.style.top = (cr.top + 40) + 'px';

  // Highlight active swatch
  const swatchContainer = popup.querySelector('.color-swatches');
  swatchContainer.querySelectorAll('.swatch').forEach(btn => {
    btn.style.outline = btn.dataset.color === hl.color ? '2px solid #007aff' : 'none';
    btn.style.outlineOffset = btn.dataset.color === hl.color ? '1px' : '0';
  });

  // Use event delegation on the swatch container (set once)
  if (!swatchContainer._hlHandlerSet) {
    swatchContainer.addEventListener('click', (e) => {
      const swatch = e.target.closest('.swatch');
      if (!swatch) return;
      const color = swatch.dataset.color;
      const p = _selHlPage, i = _selHlIdx;
      if (p < 0 || i < 0) return;

      if (color === 'transparent') {
        // "透明" = remove the highlight entirely
        pageStates[p].highlights.splice(i, 1);
        _selHlPage = _selHlIdx = -1;
        document.getElementById('highlight-props-popup').classList.add('hidden');
        fastRedrawWithOverlays(p);
        return;
      }

      // Normal color update
      pageStates[p].highlights[i].color = color;
      swatchContainer.querySelectorAll('.swatch').forEach(b => {
        b.style.outline = b.dataset.color === color ? '2px solid #007aff' : 'none';
        b.style.outlineOffset = b.dataset.color === color ? '1px' : '0';
      });
      fastRedrawWithOverlays(p);
    });
    swatchContainer._hlHandlerSet = true;
  }

  // Close
  document.getElementById('btn-highlight-close').onclick = () => {
    popup.classList.add('hidden');
  };

  // Delete button (use the same close button for now, or add a delete)
  // We'll override close's parent approach
  const deleteBtn = document.getElementById('btn-highlight-delete');
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      const p = _selHlPage, i = _selHlIdx;
      if (p >= 0 && i >= 0) {
        pageStates[p].highlights.splice(i, 1);
        _selHlPage = _selHlIdx = -1;
        fastRedrawWithOverlays(p);
      }
      popup.classList.add('hidden');
    };
  }
}

function showRectPropsPopover(ra, pageNum, idx) {
  const popup = document.getElementById('rect-props-popup');
  document.getElementById('rect-border-color').value = ra.color || '#ff3b30';
  document.getElementById('rect-fill-color').value = ra.fill || '#ffffff';
  const ov = (ra.opacity !== undefined) ? ra.opacity : 60;
  document.getElementById('rect-opacity').value = ov;
  document.getElementById('rect-opacity-val').textContent = ov + '%';
  popup.classList.remove('hidden');

  hideAllPopoversExcept('rect-props-popup');

  const canvas = document.getElementById('page-canvas-' + pageNum);
  const cr = canvas.getBoundingClientRect();
  popup.style.left = Math.min(cr.right - 280, cr.left + 40) + 'px';
  popup.style.top = (cr.top + 40) + 'px';

  document.getElementById('rect-opacity').oninput = function () {
    document.getElementById('rect-opacity-val').textContent = this.value + '%';
  };

  document.getElementById('btn-rect-apply').onclick = () => {
    ra.color = document.getElementById('rect-border-color').value;
    ra.fill = document.getElementById('rect-fill-color').value;
    ra.opacity = parseInt(document.getElementById('rect-opacity').value);
    pageStates[pageNum].rectAnnots[idx] = ra;
    popup.classList.add('hidden');
    renderSinglePage(pageNum);
  };

  document.getElementById('btn-rect-delete').onclick = () => {
    pageStates[pageNum].rectAnnots.splice(idx, 1);
    _selRectPage = _selRectIdx = -1;
    popup.classList.add('hidden');
    renderSinglePage(pageNum);
  };
}

function showTextEditPopover(block, pageNum) {
  const popup = document.getElementById('text-edit-popup');
  document.getElementById('text-edit-input').value = block.text;
  document.getElementById('text-edit-color').value = '#000000';
  popup.classList.remove('hidden');

  const canvas = document.getElementById('page-canvas-' + pageNum);
  const cr = canvas.getBoundingClientRect();
  popup.style.left = Math.min(cr.right - 280, cr.left + 40) + 'px';
  popup.style.top = (cr.top + 40) + 'px';

  document.getElementById('btn-text-save').onclick = () => {
    const newText = document.getElementById('text-edit-input').value;
    const color = document.getElementById('text-edit-color').value;
    pageStates[pageNum].edits.push({
      type: 'text', page: pageNum,
      block_id: block.id, x: block.x, y: block.y,
      width: block.width, height: block.height,
      new_text: newText, size: block.size, color,
    });
    popup.classList.add('hidden');
    renderSinglePage(pageNum);
  };

  document.getElementById('btn-text-cancel').onclick = () => {
    popup.classList.add('hidden');
  };
}

function hideAllPopoversExcept(keepId) {
  ['rect-props-popup', 'text-edit-popup', 'highlight-props-popup'].forEach(id => {
    if (id !== keepId) document.getElementById(id)?.classList.add('hidden');
  });
}

function hideAllPopovers() { hideAllPopoversExcept(null); }

/* ──────────────────────────────────────────────────────────
   Tool bar
   ────────────────────────────────────────────────────────── */
document.querySelectorAll('#editor-toolbar .segment[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.parentElement.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editorTool = btn.dataset.tool;
    _isDragging = false;
    _dragMode = null;
    hideAllPopovers();

    const fillPicker = document.getElementById('editor-fill');
    const colorPicker = document.getElementById('editor-color');
    if (editorTool === 'highlight') {
      colorPicker.title = '高亮颜色';
      // Don't reset colorPicker.value — keep user's last choice
      fillPicker.style.display = 'none';
    } else if (editorTool === 'rect') {
      colorPicker.title = '边框颜色';
      fillPicker.style.display = 'inline-block';
    } else if (editorTool === 'text') {
      colorPicker.title = '文字颜色';
      fillPicker.style.display = 'none';
    } else {
      fillPicker.style.display = 'none';
    }
  });
});

/* ──────────────────────────────────────────────────────────
   Thumbnail List
   ────────────────────────────────────────────────────────── */
async function renderThumbList() {
  const container = document.getElementById('editor-pages');
  container.innerHTML = '';

  for (let i = 0; i < editorTotalPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.page = i;
    item.innerHTML = `<canvas id="thumb-${i}"></canvas><div class="num">第 ${i + 1} 页</div>`;
    item.addEventListener('click', () => scrollToPage(i));
    container.appendChild(item);

    try {
      const page = await editorPdfDoc.getPage(i + 1);
      const vp = page.getViewport({ scale: 0.4 });
      const c = document.getElementById('thumb-' + i);
      if (c) {
        c.width = vp.width;
        c.height = vp.height;
        c.style.width = '100%';
        c.style.height = 'auto';
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    } catch (e) { /* skip */ }
  }
}

function scrollToPage(pageNum) {
  const canvas = pageStates[pageNum].canvas;
  if (!canvas) return;
  canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ──────────────────────────────────────────────────────────
   Save
   ────────────────────────────────────────────────────────── */
document.getElementById('btn-editor-save')?.addEventListener('click', async () => {
  if (!editorFileId) { alert('请先打开一个 PDF'); return; }

  // Collect all edits from all pages
  const allEdits = [];
  for (let p = 0; p < editorTotalPages; p++) {
    const st = pageStates[p];
    allEdits.push(...st.edits);
    allEdits.push(...st.rectAnnots.map(ra => ({
      type: 'add_rect', page: p,
      x: ra.x, y: ra.y, w: ra.w, h: ra.h,
      color: ra.color, fill: ra.fill,
      opacity: ra.opacity !== undefined ? ra.opacity : 60,
    })));
    allEdits.push(...st.highlights.map(hl => ({
      type: 'add_highlight', page: p,
      block_id: hl.blockId,
      x: hl.x, y: hl.y,
      width: hl.width, height: hl.height,
      color: hl.color,
    })));
  }

  if (allEdits.length === 0) { alert('没有需要保存的修改'); return; }

  const btn = document.getElementById('btn-editor-save');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const result = await api.pdfSave(editorFileId, allEdits);
    if (result.error) {
      alert('保存失败: ' + result.error);
    } else {
      editorFileId = result.id;
      // Clear all edits
      for (let p = 0; p < editorTotalPages; p++) {
        pageStates[p].edits = [];
        pageStates[p].rectAnnots = [];
        pageStates[p].highlights = [];
        pageStates[p].rendered = false;
      }
      await renderVisiblePages();
      alert('PDF 已保存');
    }
  } catch (e) {
    alert('保存出错: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = '保存';
});

/* ──────────────────────────────────────────────────────────
   Drop zone
   ────────────────────────────────────────────────────────── */
(function initDrop() {
  const drop = document.getElementById('drop-editor');
  if (!drop) return;
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag-over'); handleEditorDrop(e.dataTransfer.files);
  });
  drop.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.pdf';
    input.onchange = (ev) => { if (ev.target.files.length > 0) loadEditorPdf(ev.target.files[0]); };
    input.click();
  });
})();
