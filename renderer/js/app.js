/**
 * DocForge — Main App Controller
 * macOS native style — tab navigation, backend API, shared state.
 */

// ── State ──────────────────────────────────────────────────
const STATE = {
  backendPort: 17520,
  uploadedFiles: [],
  splitFile: null,
  mergeFiles: [],
  pagesFile: null,
  editorFile: null,
  editorPages: [],
  editorCurrentPage: 0,
  editorTool: 'select',
  isMac: true,
};

// ── API helpers ────────────────────────────────────────────
const api = {
  base: () => `http://127.0.0.1:${STATE.backendPort}`,

  async upload(files) {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    const r = await fetch(`${this.base()}/api/upload`, { method: 'POST', body: fd });
    return r.json();
  },

  async convert(fileIds, targetFormat) {
    const r = await fetch(`${this.base()}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: fileIds, target_format: targetFormat }),
    });
    return r.json();
  },

  async taskStatus(taskId) {
    const r = await fetch(`${this.base()}/api/task/${taskId}`);
    return r.json();
  },

  downloadUrl(fileId) {
    return `${this.base()}/api/download/${fileId}`;
  },

  downloadAllUrl(taskId) {
    return `${this.base()}/api/download-all/${taskId}`;
  },

  async pdfSplit(fileId, ranges) {
    const r = await fetch(`${this.base()}/api/pdf/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, ranges }),
    });
    return r.json();
  },

  async pdfMerge(fileIds) {
    const r = await fetch(`${this.base()}/api/pdf/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: fileIds }),
    });
    return r.json();
  },

  async pdfParse(fileId, page) {
    const r = await fetch(`${this.base()}/api/pdf/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, page }),
    });
    return r.json();
  },

  async pdfSave(fileId, edits) {
    const r = await fetch(`${this.base()}/api/pdf/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, edits }),
    });
    return r.json();
  },

  async pdfRender(fileId, page) {
    return `${this.base()}/api/pdf/render/${fileId}/${page}`;
  },

  async pdfDeletePages(fileId, pages) {
    const r = await fetch(`${this.base()}/api/pdf/delete-pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, pages }),
    });
    return r.json();
  },

  async pdfRotatePages(fileId, rotations) {
    const r = await fetch(`${this.base()}/api/pdf/rotate-pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, rotations }),
    });
    return r.json();
  },

  async health() {
    const r = await fetch(`${this.base()}/api/health`);
    return r.json();
  },
};

// ── Init ───────────────────────────────────────────────────
async function init() {
  if (window.electronAPI) {
    STATE.backendPort = await window.electronAPI.getBackendPort();
    STATE.isMac = window.electronAPI.isMac;
    if (!window.electronAPI.isMac) {
      document.body.classList.remove('macos');
      document.body.classList.add('windows');
    }
  }

  try {
    const health = await api.health();
    console.log('Backend ready:', health);
    if (!health.libreoffice) {
      console.warn('LibreOffice 未检测到，Office 格式转换不可用');
    }
  } catch (e) {
    console.warn('Backend unreachable:', e.message);
  }

  setupTabs();
  setupSharedDropZones();
}

// ── Tab Navigation (macOS sidebar style) ──────────────────
function setupTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ── Shared Drop Zones ──────────────────────────────────────
function setupSharedDropZones() {
  document.querySelectorAll('.drop-zone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      handleDrop(zone, e.dataTransfer.files);
    });
    zone.addEventListener('click', (e) => {
      // Don't trigger when clicking on inner buttons/links
      if (e.target.closest('.link') || e.target.closest('button')) return;
      const opTab = zone.closest('.op-panel');
      if (opTab && opTab.id === 'op-merge') {
        document.getElementById('file-input-pdf').click();
      } else if (zone.id === 'drop-editor') {
        // handled in pdf-editor.js
      } else {
        document.getElementById('file-input').click();
      }
    });
  });
}

function handleDrop(zone, files) {
  const converterPanel = document.getElementById('panel-converter');
  const pdfOpsPanel = document.getElementById('panel-pdf-ops');
  const editorPanel = document.getElementById('panel-pdf-editor');

  if (converterPanel.classList.contains('active')) {
    handleConverterDrop(files);
  } else if (pdfOpsPanel.classList.contains('active')) {
    handlePdfOpsDrop(zone, files);
  } else if (editorPanel.classList.contains('active')) {
    handleEditorDrop(files);
  }
}

// ── Utility ────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extIcon(ext) {
  const map = {
    pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊',
    pptx: '📽️', ppt: '📽️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️',
    txt: '📃', csv: '📃', dxf: '📐', dwg: '📐',
  };
  return map[ext.replace('.', '').toLowerCase()] || '📁';
}

// ── Start ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
