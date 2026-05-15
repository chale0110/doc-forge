/**
 * DocForge — PDF Editor Tab (macOS style)
 * Canvas-based editor with pdf.js rendering and native interactions.
 */

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

let editorPdfDoc = null;
let editorFileId = null;
let editorPageData = null;
let editorCurrentPage = 0;
let editorTotalPages = 0;
let editorScale = 1.5;
let editorTool = 'select';
let editorEdits = [];
let editorTextBlocks = [];
let editorRectAnnots = [];  // Track rect annotations for eraser
let rectStart = null;

// ── Load PDF ───────────────────────────────────────────────
async function loadEditorPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  editorPdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  editorTotalPages = editorPdfDoc.numPages;

  const uploadResult = await api.upload([file]);
  if (uploadResult.files?.length > 0) {
    editorFileId = uploadResult.files[0].id;
    STATE.editorFile = uploadResult.files[0];
  }

  document.getElementById('editor-toolbar').classList.remove('hidden');
  await renderThumbList();
  await loadEditorPage(0);
}

function handleEditorDrop(files) {
  const pdfs = Array.from(files).filter(f =>
    f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf'
  );
  if (pdfs.length > 0) loadEditorPdf(pdfs[0]);
}

// ── Thumbnail List ────────────────────────────────────────
async function renderThumbList() {
  const container = document.getElementById('editor-pages');
  container.innerHTML = '';

  for (let i = 0; i < editorTotalPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === editorCurrentPage ? ' active' : '');
    item.innerHTML = `
      <canvas id="editor-thumb-${i}" style="width:100%"></canvas>
      <div class="num">第 ${i + 1} 页</div>
    `;
    item.addEventListener('click', () => loadEditorPage(i));
    container.appendChild(item);

    try {
      const page = await editorPdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 0.25 });
      const canvas = document.getElementById(`editor-thumb-${i}`);
      if (canvas) {
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } catch (e) { /* skip thumb render errors */ }
  }
}

// ── Load Page ──────────────────────────────────────────────
async function loadEditorPage(pageNum) {
  editorCurrentPage = pageNum;
  editorEdits = [];
  editorTextBlocks = [];
  editorRectAnnots = [];
  rectStart = null;
  document.getElementById('editor-page-info').textContent = `第 ${pageNum + 1} / ${editorTotalPages} 页`;

  // Update active thumbnail
  document.querySelectorAll('.thumb-item').forEach((el, i) => {
    el.classList.toggle('active', i === pageNum);
  });

  // Render via pdf.js
  const page = await editorPdfDoc.getPage(pageNum + 1);
  const viewport = page.getViewport({ scale: editorScale });

  const canvas = document.getElementById('editor-canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Fetch text structure
  try {
    editorPageData = await api.pdfParse(editorFileId, pageNum);
    editorTextBlocks = editorPageData.text_blocks || [];
    drawTextBlockOverlays(ctx, viewport);
  } catch (e) { /* parse fail — no overlays */ }

  setupCanvasInteraction(canvas, viewport);
  setupScrollZoom();
}

// ── Text Block Overlays ────────────────────────────────────
function drawTextBlockOverlays(ctx, viewport) {
  const scaleX = viewport.width / (editorPageData?.width || 595);
  const scaleY = viewport.height / (editorPageData?.height || 842);

  editorTextBlocks.forEach(block => {
    const x = block.x * scaleX;
    const y = block.y * scaleY;
    const w = block.width * scaleX;
    const h = block.height * scaleY;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 122, 255, 0.25)';
    ctx.lineWidth = 0.75;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.restore();
  });
}

// ── Canvas Interaction ─────────────────────────────────────
// Track the current click handler so we can remove old ones
let _editorClickHandler = null;

function setupCanvasInteraction(canvas, viewport) {
  // Remove old handler, attach new one (NO clone — preserves pixel data)
  if (_editorClickHandler) {
    canvas.removeEventListener('click', _editorClickHandler);
  }

  const scaleX = viewport.width / (editorPageData?.width || 595);
  const scaleY = viewport.height / (editorPageData?.height || 842);

  _editorClickHandler = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    if (editorTool === 'select') handleSelectClick(mx, my, scaleX, scaleY);
    else if (editorTool === 'text') handleTextAddClick(mx, my, canvas);
    else if (editorTool === 'rect') handleRectAddClick(mx, my, canvas);
    else if (editorTool === 'eraser') handleEraserClick(mx, my, scaleX, scaleY);
  };

  canvas.addEventListener('click', _editorClickHandler);
}

// ── Scroll Wheel Zoom ────────────────────────────────────
let _zoomHandler = null;
function setupScrollZoom() {
  const container = document.getElementById('editor-canvas-container');
  if (!container) return;
  if (_zoomHandler) container.removeEventListener('wheel', _zoomHandler);

  _zoomHandler = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    editorScale = Math.max(0.3, Math.min(4.0, editorScale + delta));
    loadEditorPage(editorCurrentPage);
  };
  container.addEventListener('wheel', _zoomHandler, { passive: false });
}

// ── Select Tool ────────────────────────────────────────────
let _selectedRectIdx = -1;  // Currently selected rect annotation index

function handleSelectClick(mx, my, scaleX, scaleY) {
  // 1. Check rect annotations first (drawn on top)
  for (let i = editorRectAnnots.length - 1; i >= 0; i--) {
    const ra = editorRectAnnots[i];
    if (mx >= ra.x && mx <= ra.x + ra.w && my >= ra.y && my <= ra.y + ra.h) {
      _selectedRectIdx = i;
      showRectPropsPopover(ra, i);
      return;
    }
  }
  // 2. Check text blocks
  for (const block of editorTextBlocks) {
    const bx = block.x * scaleX;
    const by = block.y * scaleY;
    const bw = block.width * scaleX;
    const bh = block.height * scaleY;
    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      showTextEditPopover(block);
      return;
    }
  }
  _selectedRectIdx = -1;
}

// ── Rect Properties Popover ──────────────────────────────
function showRectPropsPopover(ra, idx) {
  const popup = document.getElementById('rect-props-popup');
  document.getElementById('rect-border-color').value = ra.color;
  document.getElementById('rect-fill-color').value = ra.fill;
  popup.classList.remove('hidden');

  const canvas = document.getElementById('editor-canvas');
  const cr = canvas.getBoundingClientRect();
  popup.style.left = Math.min(cr.right - 260, cr.left + 40) + 'px';
  popup.style.top = (cr.top + 60) + 'px';

  document.getElementById('btn-rect-apply').onclick = () => {
    ra.color = document.getElementById('rect-border-color').value;
    ra.fill = document.getElementById('rect-fill-color').value;
    editorRectAnnots[idx] = ra;
    popup.classList.add('hidden');
    loadEditorPage(editorCurrentPage);
  };

  document.getElementById('btn-rect-delete').onclick = () => {
    editorRectAnnots.splice(idx, 1);
    _selectedRectIdx = -1;
    popup.classList.add('hidden');
    loadEditorPage(editorCurrentPage);
  };
}

// ── Text Edit Popover ─────────────────────────────────────
function showTextEditPopover(block) {
  const popup = document.getElementById('text-edit-popup');
  const textarea = document.getElementById('text-edit-input');
  textarea.value = block.text;
  document.getElementById('text-edit-color').value = '#000000';
  popup.classList.remove('hidden');

  const canvas = document.getElementById('editor-canvas');
  const cr = canvas.getBoundingClientRect();
  popup.style.left = Math.min(cr.right - 280, cr.left + 40) + 'px';
  popup.style.top = (cr.top + 60) + 'px';

  document.getElementById('btn-text-save').onclick = () => {
    const newText = textarea.value;
    const color = document.getElementById('text-edit-color').value;
    editorEdits.push({
      type: 'text', page: editorCurrentPage,
      block_id: block.id, x: block.x, y: block.y,
      width: block.width, height: block.height,
      new_text: newText, size: block.size, color,
    });
    popup.classList.add('hidden');
    loadEditorPage(editorCurrentPage);
  };

  document.getElementById('btn-text-cancel').onclick = () => {
    popup.classList.add('hidden');
  };
}

// ── Text Add Tool ──────────────────────────────────────────
function handleTextAddClick(mx, my, canvas) {
  const text = prompt('输入文字:');
  if (!text) return;

  const color = document.getElementById('editor-color')?.value || '#000000';

  editorEdits.push({
    type: 'add_text', page: editorCurrentPage,
    x: mx, y: my, text, size: 14, color,
  });

  const ctx = canvas.getContext('2d');
  ctx.font = '14px -apple-system, sans-serif';
  ctx.fillStyle = color;
  ctx.fillText(text, mx, my);
  setTimeout(() => loadEditorPage(editorCurrentPage), 400);
}

// ── Rect Add Tool ──────────────────────────────────────────
function handleRectAddClick(mx, my, canvas) {
  if (!rectStart) {
    rectStart = { x: mx, y: my };
  } else {
    const x = Math.min(rectStart.x, mx);
    const y = Math.min(rectStart.y, my);
    const w = Math.abs(mx - rectStart.x);
    const h = Math.abs(my - rectStart.y);

    const color = document.getElementById('editor-color')?.value || '#ff3b30';
    const fill = document.getElementById('editor-fill')?.value || '#ffffff';

    editorEdits.push({
      type: 'add_rect', page: editorCurrentPage,
      x, y, w, h, color, fill,
    });

    const ctx = canvas.getContext('2d');
    if (fill !== '#ffffff') {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Track for eraser
    editorRectAnnots.push({ x, y, w, h, color, fill });

    rectStart = null;
    setTimeout(() => loadEditorPage(editorCurrentPage), 400);
  }
}

// ── Eraser Tool ────────────────────────────────────────────
function handleEraserClick(mx, my, scaleX, scaleY) {
  // Check text blocks
  for (let i = editorTextBlocks.length - 1; i >= 0; i--) {
    const block = editorTextBlocks[i];
    const bx = block.x * scaleX;
    const by = block.y * scaleY;
    const bw = block.width * scaleX;
    const bh = block.height * scaleY;

    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      editorEdits.push({
        type: 'text', page: editorCurrentPage,
        block_id: block.id, x: block.x, y: block.y,
        width: block.width, height: block.height,
        new_text: '', size: block.size,
      });
      loadEditorPage(editorCurrentPage);
      return;
    }
  }
  // Check rect annotations (scale is 1:1 since drawn in canvas coords)
  for (let i = editorRectAnnots.length - 1; i >= 0; i--) {
    const ra = editorRectAnnots[i];
    if (mx >= ra.x && mx <= ra.x + ra.w && my >= ra.y && my <= ra.y + ra.h) {
      editorRectAnnots.splice(i, 1);
      // Remove from edits too — reload page without this rect
      loadEditorPage(editorCurrentPage);
      return;
    }
  }
}

// ── Tool Segmented Control ─────────────────────────────────
document.querySelectorAll('#editor-toolbar .segment[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.parentElement.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editorTool = btn.dataset.tool;
    rectStart = null;
  });
});

// ── Save ───────────────────────────────────────────────────
document.getElementById('btn-editor-save')?.addEventListener('click', async () => {
  if (!editorFileId) {
    alert('请先打开一个 PDF');
    return;
  }

  // Rebuild rect edits from current state (eraser may have removed some)
  const nonRectEdits = editorEdits.filter(e => e.type !== 'add_rect');
  const currentRects = editorRectAnnots.map(ra => ({
    type: 'add_rect', page: editorCurrentPage,
    x: ra.x, y: ra.y, w: ra.w, h: ra.h,
    color: ra.color, fill: ra.fill,
  }));
  const finalEdits = [...nonRectEdits, ...currentRects];

  if (finalEdits.length === 0 && editorRectAnnots.length === 0) {
    alert('没有需要保存的修改');
    return;
  }

  const btn = document.getElementById('btn-editor-save');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const result = await api.pdfSave(editorFileId, finalEdits);
    if (result.error) {
      alert('保存失败: ' + result.error);
    } else {
      editorFileId = result.id;
      editorEdits = [];
      editorRectAnnots = [];
      alert('PDF 已保存');
    }
  } catch (e) {
    alert('保存出错: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = '保存';
});

// ── Editor Drop Zone ───────────────────────────────────────
document.getElementById('drop-editor')?.addEventListener('dragover', e => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('drop-editor').classList.add('drag-over');
});
document.getElementById('drop-editor')?.addEventListener('dragleave', () => {
  document.getElementById('drop-editor').classList.remove('drag-over');
});
document.getElementById('drop-editor')?.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('drop-editor').classList.remove('drag-over');
  handleEditorDrop(e.dataTransfer.files);
});
document.getElementById('drop-editor')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf';
  input.onchange = (e) => {
    if (e.target.files.length > 0) loadEditorPdf(e.target.files[0]);
  };
  input.click();
});
