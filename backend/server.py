import os
import sys
import uuid
import shutil
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify, send_file, Response
from flask_cors import CORS

from engine.converter import ConversionEngine
from engine.pdf_ops import PDFOps

app = Flask(__name__)
CORS(app)

# ── Config ─────────────────────────────────────────────────
# PyInstaller: use DOCFORGE_DATA_DIR (set by Electron main.js)
# or fall back to exe parent / source tree
if getattr(sys, 'frozen', False):
    data_dir = os.environ.get('DOCFORGE_DATA_DIR')
    if data_dir:
        BASE_DIR = Path(data_dir)
    else:
        BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent.parent

UPLOAD_DIR = BASE_DIR / 'uploads'
OUTPUT_DIR = BASE_DIR / 'outputs'
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

converter = ConversionEngine(UPLOAD_DIR, OUTPUT_DIR)
pdf_ops = PDFOps(UPLOAD_DIR, OUTPUT_DIR)

# In-memory task store
tasks = {}


def _task_id():
    return uuid.uuid4().hex[:12]


# ── Health ──────────────────────────────────────────────────
@app.route('/api/health')
def health():
    return jsonify({
        'status': 'ok',
        'libreoffice': converter.lo_available,
        'lo_note': 'LibreOffice 可选，不装也能转换（纯 Python 引擎）' if not converter.lo_available else '已检测到 LibreOffice',
        'formats': converter.supported_formats
    })


# ── Formats ─────────────────────────────────────────────────
@app.route('/api/formats')
def formats():
    return jsonify({
        'input': converter.supported_formats,
        'output': converter.supported_formats,
        'matrix': converter.conversion_matrix
    })


# ── Upload ──────────────────────────────────────────────────
@app.route('/api/upload', methods=['POST'])
def upload():
    files = request.files.getlist('files')
    if not files:
        return jsonify({'error': '没有文件'}), 400

    saved = []
    for f in files:
        if f.filename:
            ext = Path(f.filename).suffix.lower()
            safe_name = f"{uuid.uuid4().hex[:8]}{ext}"
            dest = UPLOAD_DIR / safe_name
            f.save(dest)
            saved.append({
                'id': safe_name,
                'original': f.filename,
                'path': str(dest),
                'size': dest.stat().st_size,
                'ext': ext
            })

    return jsonify({'files': saved})


# ── Convert ─────────────────────────────────────────────────
@app.route('/api/convert', methods=['POST'])
def convert():
    data = request.get_json()
    file_ids = data.get('file_ids', [])
    target_fmt = data.get('target_format', 'pdf').lower()

    if not file_ids:
        return jsonify({'error': '没有文件'}), 400

    tid = _task_id()
    tasks[tid] = {'status': 'processing', 'progress': 0, 'results': [], 'error': None}

    def run():
        try:
            results = []
            total = len(file_ids)
            for i, fid in enumerate(file_ids):
                src_path = UPLOAD_DIR / fid
                if not src_path.exists():
                    continue
                out_path = converter.convert(str(src_path), target_fmt)
                results.append({
                    'id': out_path.name,
                    'original': fid,
                    'path': str(out_path),
                    'size': out_path.stat().st_size
                })
                tasks[tid]['progress'] = int((i + 1) / total * 90)
            tasks[tid]['results'] = results
            tasks[tid]['progress'] = 100
            tasks[tid]['status'] = 'done'
        except Exception as e:
            tasks[tid]['status'] = 'error'
            tasks[tid]['error'] = str(e)

    import threading
    t = threading.Thread(target=run)
    t.start()

    return jsonify({'task_id': tid})


# ── Task Status ─────────────────────────────────────────────
@app.route('/api/task/<tid>')
def task_status(tid):
    t = tasks.get(tid)
    if not t:
        return jsonify({'error': '任务不存在'}), 404
    return jsonify(t)


# ── Download ────────────────────────────────────────────────
@app.route('/api/download/<fid>')
def download_file(fid):
    # Look in outputs first, then uploads
    for d in [OUTPUT_DIR, UPLOAD_DIR]:
        fp = d / fid
        if fp.exists():
            return send_file(fp, as_attachment=True)
    return jsonify({'error': '文件不存在'}), 404


@app.route('/api/download-all/<tid>')
def download_all(tid):
    t = tasks.get(tid)
    if not t or not t.get('results'):
        return jsonify({'error': '无结果'}), 404

    import zipfile, io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for r in t['results']:
            fp = Path(r['path'])
            if fp.exists():
                zf.write(fp, fp.name)
    buf.seek(0)
    return send_file(buf, mimetype='application/zip', as_attachment=True,
                     download_name=f'converted_{tid}.zip')


# ── PDF Split ───────────────────────────────────────────────
@app.route('/api/pdf/split', methods=['POST'])
def pdf_split():
    data = request.get_json()
    file_id = data.get('file_id')
    ranges = data.get('ranges')  # e.g. "1-3,5,7-9"

    src_path = UPLOAD_DIR / file_id
    if not src_path.exists():
        return jsonify({'error': '文件不存在'}), 404

    try:
        out_files = pdf_ops.split_pdf(str(src_path), ranges)
        return jsonify({'files': [{'id': f.name, 'name': f.name, 'path': str(f)} for f in out_files]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── PDF Merge ───────────────────────────────────────────────
@app.route('/api/pdf/merge', methods=['POST'])
def pdf_merge():
    data = request.get_json()
    file_ids = data.get('file_ids', [])

    paths = [str(UPLOAD_DIR / fid) for fid in file_ids if (UPLOAD_DIR / fid).exists()]
    if len(paths) < 2:
        return jsonify({'error': '至少需要2个PDF文件'}), 400

    try:
        out = pdf_ops.merge_pdfs(paths)
        return jsonify({'id': out.name, 'name': out.name, 'path': str(out)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── PDF Page Operations ─────────────────────────────────────
@app.route('/api/pdf/delete-pages', methods=['POST'])
def pdf_delete_pages():
    data = request.get_json()
    src = UPLOAD_DIR / data['file_id']
    pages = data.get('pages', [])  # list of 0-indexed page numbers
    try:
        out = pdf_ops.delete_pages(str(src), pages)
        return jsonify({'id': out.name, 'name': out.name, 'path': str(out)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/pdf/rotate-pages', methods=['POST'])
def pdf_rotate_pages():
    data = request.get_json()
    src = UPLOAD_DIR / data['file_id']
    rotations = data.get('rotations', {})  # {page_num: angle}
    try:
        out = pdf_ops.rotate_pages(str(src), rotations)
        return jsonify({'id': out.name, 'name': out.name, 'path': str(out)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/pdf/reorder', methods=['POST'])
def pdf_reorder():
    data = request.get_json()
    src = UPLOAD_DIR / data['file_id']
    order = data.get('order', [])  # new order of 0-indexed page numbers
    try:
        out = pdf_ops.reorder_pages(str(src), order)
        return jsonify({'id': out.name, 'name': out.name, 'path': str(out)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── PDF Editor ──────────────────────────────────────────────
@app.route('/api/pdf/parse', methods=['POST'])
def pdf_parse():
    """Extract text blocks, images, and structure from a PDF page."""
    data = request.get_json()
    src = UPLOAD_DIR / data['file_id']
    page_num = data.get('page', 0)
    try:
        structure = pdf_ops.parse_page(str(src), page_num)
        return jsonify(structure)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/pdf/save', methods=['POST'])
def pdf_save():
    """Save edited PDF: apply text/image changes, generate new PDF."""
    data = request.get_json()
    src = UPLOAD_DIR / data['file_id']
    edits = data.get('edits', [])  # list of edit operations
    try:
        out = pdf_ops.apply_edits(str(src), edits)
        return jsonify({'id': out.name, 'name': out.name, 'path': str(out)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/pdf/render/<file_id>/<int:page>')
def pdf_render_page(file_id, page):
    """Render a PDF page as PNG for display in the editor."""
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({'error': '文件不存在'}), 404
    try:
        png_path = pdf_ops.render_page(str(src), page)
        return send_file(png_path, mimetype='image/png')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Start ───────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 17520))
    print(f'DocForge backend starting on port {port}...')
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
