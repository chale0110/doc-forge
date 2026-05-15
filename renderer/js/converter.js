/**
 * DocForge — Converter Tab (macOS style)
 */

let converterFiles = [];

// ── File Input ─────────────────────────────────────────────
document.getElementById('file-input')?.addEventListener('change', (e) => {
  addConverterFiles(Array.from(e.target.files));
  e.target.value = '';
});

// Note: file-input-pdf is handled by pdf-split.js

document.getElementById('btn-browse')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('file-input').click();
});

// ── Handle Converter Drop ──────────────────────────────────
function handleConverterDrop(files) {
  addConverterFiles(Array.from(files));
}

function addConverterFiles(files) {
  files.forEach(f => {
    if (!converterFiles.find(cf => cf.name === f.name && cf.size === f.size)) {
      converterFiles.push(f);
    }
  });
  renderConverterFileList();
}

function removeConverterFile(index) {
  converterFiles.splice(index, 1);
  renderConverterFileList();
}

function renderConverterFileList() {
  const list = document.getElementById('file-list');
  const bar = document.getElementById('convert-bar');

  if (converterFiles.length === 0) {
    list.innerHTML = '';
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  document.getElementById('file-count').textContent = `${converterFiles.length} 个文件`;

  list.innerHTML = converterFiles.map((f, i) => {
    const ext = f.name.split('.').pop().toLowerCase();
    return `
      <div class="file-item">
        <span>${extIcon(ext)}</span>
        <span class="name">${f.name}</span>
        <span class="meta">${formatSize(f.size)}</span>
        <span class="remove" onclick="removeConverterFile(${i})">×</span>
      </div>
    `;
  }).join('');
}

// ── Convert ────────────────────────────────────────────────
document.getElementById('btn-convert')?.addEventListener('click', startConversion);

async function startConversion() {
  if (converterFiles.length === 0) return;

  const targetFmt = document.getElementById('target-format').value;
  const btn = document.getElementById('btn-convert');
  const progressArea = document.getElementById('progress-area');
  const resultsArea = document.getElementById('results-area');

  btn.disabled = true;
  btn.textContent = '上传中…';

  const uploadResult = await api.upload(converterFiles);
  if (uploadResult.error) {
    alert('上传失败: ' + uploadResult.error);
    btn.disabled = false;
    btn.textContent = '开始转换';
    return;
  }

  const fileIds = uploadResult.files.map(f => f.id);
  STATE.uploadedFiles = uploadResult.files;

  btn.textContent = '转换中…';
  progressArea.classList.remove('hidden');
  resultsArea.classList.add('hidden');

  const convertResult = await api.convert(fileIds, targetFmt);
  if (convertResult.error) {
    alert('转换失败: ' + convertResult.error);
    btn.disabled = false;
    btn.textContent = '开始转换';
    return;
  }

  const taskId = convertResult.task_id;
  await pollTask(taskId);

  btn.disabled = false;
  btn.textContent = '开始转换';
}

async function pollTask(taskId) {
  const progressFill = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const resultsArea = document.getElementById('results-area');
  const resultsList = document.getElementById('results-list');

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      const status = await api.taskStatus(taskId);

      progressFill.style.width = status.progress + '%';
      progressText.textContent = status.progress + '%';

      if (status.status === 'done') {
        clearInterval(interval);
        resultsArea.classList.remove('hidden');
        resultsList.innerHTML = status.results.map(r => `
          <div class="result-item">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${r.original}</span>
            <span class="download" onclick="downloadFile('${r.id}')" title="下载">↓</span>
          </div>
        `).join('');
        document.getElementById('btn-download-all').onclick = () => {
          window.open(api.downloadAllUrl(taskId), '_blank');
        };
        resolve();
      } else if (status.status === 'error') {
        clearInterval(interval);
        resultsArea.classList.remove('hidden');
        resultsList.innerHTML = `<p style="color:var(--sys-red)">错误: ${status.error}</p>`;
        resolve();
      }
    }, 500);
  });
}

function downloadFile(fileId) {
  window.open(api.downloadUrl(fileId), '_blank');
}
