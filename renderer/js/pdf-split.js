/**
 * DocForge — PDF Split & Merge Tab (macOS style)
 */

let splitFile = null;
let mergeFiles = [];
let pagesFile = null;
let pagesFileId = null;
let pagesSelected = new Set();

// ── Ops Sub-Tabs (segmented control) ──────────────────────
document.querySelectorAll('.segment[data-op]').forEach(btn => {
  btn.addEventListener('click', () => {
    const parent = btn.closest('.segmented-control');
    parent.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.op-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`op-${btn.dataset.op}`).classList.add('active');
  });
});

// ── Handle PDF Ops Drop ────────────────────────────────────
function handlePdfOpsDrop(zone, files) {
  const activeOp = document.querySelector('.op-panel.active');
  if (!activeOp) return;

  if (activeOp.id === 'op-split') {
    const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length > 0) setSplitFile(pdfs[0]);
  } else if (activeOp.id === 'op-merge') {
    addMergeFiles(Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf')));
  } else if (activeOp.id === 'op-pages') {
    const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length > 0) setPagesFile(pdfs[0]);
  }
}

// ── File Input for PDF ─────────────────────────────────────
document.getElementById('file-input-pdf')?.addEventListener('change', function(e) {
  const files = Array.from(e.target.files || []);
  const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) return;
  const activeOp = document.querySelector('.op-panel.active');
  if (activeOp?.id === 'op-split') setSplitFile(pdfs[0]);
  else if (activeOp?.id === 'op-merge') addMergeFiles(pdfs);
  else if (activeOp?.id === 'op-pages') setPagesFile(pdfs[0]);
  e.target.value = '';
});

// ── Browse buttons ─────────────────────────────────────────
['btn-split-browse', 'btn-merge-browse', 'btn-pages-browse'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('file-input-pdf').click();
  });
});

// ── Split ──────────────────────────────────────────────────
async function setSplitFile(file) {
  splitFile = file;
  document.getElementById('drop-split').classList.add('hidden');
  const info = document.getElementById('split-file-info');
  info.classList.remove('hidden');
  document.getElementById('split-filename').textContent = file.name;

  const result = await api.upload([file]);
  if (result.files?.length > 0) {
    STATE.splitFile = result.files[0];
    try {
      const parsed = await api.pdfParse(result.files[0].id, 0);
      document.getElementById('split-page-count').textContent = `共 ${parsed.total_pages} 页`;
    } catch (e) {
      document.getElementById('split-page-count').textContent = '';
    }
  }
  document.getElementById('btn-split').classList.remove('hidden');
}

document.getElementById('btn-split')?.addEventListener('click', async () => {
  if (!STATE.splitFile) return;
  const ranges = document.getElementById('split-ranges').value || null;
  const btn = document.getElementById('btn-split');
  btn.disabled = true;
  btn.textContent = '拆分中…';

  const result = await api.pdfSplit(STATE.splitFile.id, ranges);
  showResults('split-results', result);
  btn.disabled = false;
  btn.textContent = '执行拆分';
});

// ── Merge ──────────────────────────────────────────────────
function addMergeFiles(files) {
  files.forEach(f => {
    if (!mergeFiles.find(mf => mf.name === f.name && mf.size === f.size)) {
      mergeFiles.push(f);
    }
  });
  renderMergeList();
}

function removeMergeFile(index) {
  mergeFiles.splice(index, 1);
  renderMergeList();
}

function renderMergeList() {
  const list = document.getElementById('merge-file-list');
  const btn = document.getElementById('btn-merge');

  if (mergeFiles.length === 0) {
    list.innerHTML = '';
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');
  list.innerHTML = mergeFiles.map((f, i) => `
    <div class="merge-item">
      <span class="drag">⠿</span>
      <span>📄 ${f.name}</span>
      <span class="meta" style="margin-left:auto">${formatSize(f.size)}</span>
      <span class="remove" onclick="removeMergeFile(${i})">×</span>
    </div>
  `).join('');
}

document.getElementById('btn-merge')?.addEventListener('click', async () => {
  if (mergeFiles.length < 2) return;
  const btn = document.getElementById('btn-merge');
  btn.disabled = true;
  btn.textContent = '合并中…';

  const uploadResult = await api.upload(mergeFiles);
  if (uploadResult.error) {
    alert('上传失败: ' + uploadResult.error);
    btn.disabled = false;
    btn.textContent = '合并 PDF';
    return;
  }

  const fileIds = uploadResult.files.map(f => f.id);
  const result = await api.pdfMerge(fileIds);
  showResults('merge-results', result);
  btn.disabled = false;
  btn.textContent = '合并 PDF';
});

// ── Page Operations ────────────────────────────────────────
let pagesPdfDoc = null;  // pdf.js document for thumbnails

async function setPagesFile(file) {
  pagesFile = file;
  const result = await api.upload([file]);
  if (result.files?.length > 0) {
    pagesFileId = result.files[0].id;
    STATE.pagesFile = result.files[0];
  }
  // Load PDF client-side for thumbnail rendering
  const buf = await file.arrayBuffer();
  if (typeof pdfjsLib !== 'undefined') {
    pagesPdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
  }
  await renderPagesPreview();
}

async function renderPagesPreview() {
  const container = document.getElementById('pages-preview');
  const actions = document.getElementById('pages-actions');
  container.classList.remove('hidden');
  actions.style.display = 'flex';
  pagesSelected.clear();

  const total = pagesPdfDoc ? pagesPdfDoc.numPages : 1;

  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.page = i;
    card.innerHTML = `
      <canvas id="thumb-canvas-${i}"></canvas>
      <div class="num">第 ${i + 1} 页</div>
    `;
    card.addEventListener('click', () => {
      card.classList.toggle('selected');
      if (card.classList.contains('selected')) {
        pagesSelected.add(i);
      } else {
        pagesSelected.delete(i);
      }
    });
    container.appendChild(card);
  }

  // Render thumbnails client-side with pdf.js
  if (pagesPdfDoc) {
    for (let i = 0; i < Math.min(total, 20); i++) {
      try {
        const page = await pagesPdfDoc.getPage(i + 1);
        const vp = page.getViewport({ scale: 0.5 });
        const canvas = document.getElementById(`thumb-canvas-${i}`);
        if (canvas) {
          canvas.width = vp.width;
          canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        }
      } catch (e) { /* skip */ }
    }
  }
}

document.getElementById('btn-delete-sel')?.addEventListener('click', async () => {
  if (pagesSelected.size === 0) return;
  const pages = Array.from(pagesSelected);
  const result = await api.pdfDeletePages(pagesFileId, pages);
  if (!result.error) {
    pagesFileId = result.id;
    pagesSelected.clear();
    await renderPagesPreview();
  }
});

document.getElementById('btn-rotate-sel')?.addEventListener('click', async () => {
  if (pagesSelected.size === 0) return;
  const rotations = {};
  pagesSelected.forEach(p => { rotations[p] = 90; });
  const result = await api.pdfRotatePages(pagesFileId, rotations);
  if (!result.error) {
    pagesFileId = result.id;
    pagesSelected.clear();
    await renderPagesPreview();
  }
});

document.getElementById('btn-apply-pages')?.addEventListener('click', () => {
  showResults('pages-results', { id: pagesFileId, name: `edited_${Date.now()}.pdf` });
});

// ── Shared results display ─────────────────────────────────
function showResults(containerId, result) {
  const container = document.getElementById(containerId);
  if (result.error) {
    container.innerHTML = `<p style="color:var(--sys-red)">${result.error}</p>`;
    return;
  }
  const items = result.files || [result];
  container.innerHTML = items.map(f => `
    <div class="result-item">
      <span>📄 ${f.name || f.id}</span>
      <span class="download" onclick="downloadFile('${f.id}')">↓</span>
    </div>
  `).join('');
}
