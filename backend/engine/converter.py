"""
DocForge 格式转换引擎 (纯 Python 版)

全部转换使用 Python 库完成，无需 LibreOffice。
Office 格式转换通过 python-docx / openpyxl / python-pptx + reportlab 实现。
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional


class ConversionEngine:
    SUPPORTED_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'txt', 'dxf']

    def __init__(self, upload_dir: Path, output_dir: Path):
        self.upload_dir = upload_dir
        self.output_dir = output_dir
        # LibreOffice is optional — try to find it for better quality
        self.lo_available = self._detect_libreoffice()

    @property
    def conversion_matrix(self) -> dict:
        m = {}
        for s in self.SUPPORTED_FORMATS:
            m[s] = {d: 'python' for d in self.SUPPORTED_FORMATS if s != d}
            m[s][s] = 'identity'
        return m

    @property
    def supported_formats(self) -> List[str]:
        return self.SUPPORTED_FORMATS

    # ═══════════════════════════════════════════════════════
    #  Main entry
    # ═══════════════════════════════════════════════════════
    def convert(self, src_path: str, target_fmt: str) -> Path:
        src = Path(src_path)
        src_fmt = src.suffix.lower().lstrip('.')
        dst_fmt = target_fmt.lower().lstrip('.')

        if src_fmt not in self.SUPPORTED_FORMATS:
            raise ValueError(f'不支持源格式: {src_fmt}')
        if dst_fmt not in self.SUPPORTED_FORMATS:
            raise ValueError(f'不支持目标格式: {dst_fmt}')

        out_path = self.output_dir / f'{src.stem}.{dst_fmt}'

        if src_fmt == dst_fmt:
            shutil.copy2(src, out_path)
            return out_path

        # Try LibreOffice first for Office formats (better quality)
        if self.lo_available and self._can_use_lo(src_fmt, dst_fmt):
            try:
                return self._convert_lo(src, dst_fmt, out_path)
            except Exception:
                pass  # fall through to Python

        # Python-native conversion
        handler = getattr(self, f'_conv_{src_fmt}_to_{dst_fmt}', None)
        if handler:
            handler(src, out_path)
            return out_path

        # Generic: try intermediate PDF
        try:
            return self._via_pdf(src, dst_fmt)
        except Exception as e:
            raise RuntimeError(f'不支持 {src_fmt} → {dst_fmt}: {e}')

    def _can_use_lo(self, src_fmt, dst_fmt):
        """Only use LO for Office ↔ Office or Office ↔ PDF."""
        office = {'docx', 'xlsx', 'pptx', 'pdf', 'dxf'}
        return src_fmt in office and dst_fmt in office

    def _via_pdf(self, src: Path, dst_fmt: str) -> Path:
        """Two-step: src → PDF → dst."""
        pdf_path = self.output_dir / f'{src.stem}_tmp.pdf'
        self._to_pdf(src, pdf_path)
        result = self.convert(str(pdf_path), dst_fmt)
        if pdf_path.exists():
            pdf_path.unlink()
        return result

    def _to_pdf(self, src: Path, out: Path):
        """Convert anything to PDF."""
        fmt = src.suffix.lower().lstrip('.')
        handler = getattr(self, f'_conv_{fmt}_to_pdf', None)
        if handler:
            handler(src, out)
        else:
            raise RuntimeError(f'无法将 {fmt} 转为 PDF')

    # ═══════════════════════════════════════════════════════
    #  DOCX conversions
    # ═══════════════════════════════════════════════════════
    def _conv_docx_to_pdf(self, src: Path, out: Path):
        from docx import Document
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        from reportlab.lib.units import mm

        doc = Document(src)
        w, h = A4
        c = canvas.Canvas(str(out), pagesize=A4)
        y = h - 50

        for para in doc.paragraphs:
            text = para.text.strip()
            if not text:
                y -= 12
            else:
                c.setFont('Helvetica', 11)
                for line in self._wrap_text(text, 90, c):
                    if y < 50:
                        c.showPage()
                        c.setFont('Helvetica', 11)
                        y = h - 50
                    c.drawString(50, y, line)
                    y -= 14
                y -= 4
            if y < 50:
                c.showPage()
                y = h - 50
        c.save()

    def _conv_docx_to_txt(self, src: Path, out: Path):
        from docx import Document
        doc = Document(src)
        text = '\n'.join(p.text for p in doc.paragraphs)
        out.write_text(text, encoding='utf-8')

    # ═══════════════════════════════════════════════════════
    #  XLSX conversions
    # ═══════════════════════════════════════════════════════
    def _conv_xlsx_to_pdf(self, src: Path, out: Path):
        from openpyxl import load_workbook
        from reportlab.lib.pagesizes import A4, A3
        from reportlab.pdfgen import canvas

        wb = load_workbook(src, data_only=True)
        ws = wb.active
        pg = A3 if ws.max_column > 8 else A4
        pw, ph = pg
        c = canvas.Canvas(str(out), pagesize=pg)
        c.setFont('Helvetica', 8)

        row_h = 16
        col_w = (pw - 40) / max(ws.max_column, 1)
        y = ph - 30

        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, 200), values_only=True):
            x = 20
            for val in row:
                if val is not None:
                    c.drawString(x, y, str(val)[:int(col_w / 5)])
                x += col_w
            y -= row_h
            if y < 30:
                c.showPage()
                c.setFont('Helvetica', 8)
                y = ph - 30
        c.save()

    def _conv_xlsx_to_txt(self, src: Path, out: Path):
        from openpyxl import load_workbook
        wb = load_workbook(src, data_only=True)
        lines = []
        for row in wb.active.iter_rows(values_only=True):
            lines.append('\t'.join(str(v or '') for v in row))
        out.write_text('\n'.join(lines), encoding='utf-8')

    # ═══════════════════════════════════════════════════════
    #  PPTX conversions
    # ═══════════════════════════════════════════════════════
    def _conv_pptx_to_pdf(self, src: Path, out: Path):
        from pptx import Presentation
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        prs = Presentation(src)
        w, h = A4
        c = canvas.Canvas(str(out), pagesize=A4)

        for slide in prs.slides:
            c.setFont('Helvetica-Bold', 14)
            c.drawString(50, h - 50, f'Slide')
            y = h - 80
            c.setFont('Helvetica', 10)
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = para.text.strip()
                        if t:
                            c.drawString(60, y, t[:100])
                            y -= 16
                            if y < 40:
                                c.showPage()
                                y = h - 50
            c.showPage()
        c.save()

    def _conv_pptx_to_txt(self, src: Path, out: Path):
        from pptx import Presentation
        prs = Presentation(src)
        lines = []
        for i, slide in enumerate(prs.slides):
            lines.append(f'--- Slide {i+1} ---')
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        if para.text.strip():
                            lines.append(para.text)
        out.write_text('\n'.join(lines), encoding='utf-8')

    # ═══════════════════════════════════════════════════════
    #  PDF conversions
    # ═══════════════════════════════════════════════════════
    def _conv_pdf_to_txt(self, src: Path, out: Path):
        import pdfplumber
        text = []
        with pdfplumber.open(src) as pdf:
            for page in pdf.pages:
                t = page.extract_text()
                if t:
                    text.append(t)
        out.write_text('\n'.join(text), encoding='utf-8')

    def _conv_pdf_to_docx(self, src: Path, out: Path):
        import pdfplumber
        from docx import Document
        doc = Document()
        with pdfplumber.open(src) as pdf:
            for page in pdf.pages:
                t = page.extract_text()
                if t:
                    doc.add_paragraph(t)
        doc.save(str(out))

    # ═══════════════════════════════════════════════════════
    #  TXT conversions
    # ═══════════════════════════════════════════════════════
    def _conv_txt_to_pdf(self, src: Path, out: Path):
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        text = src.read_text(encoding='utf-8', errors='replace')
        w, h = A4
        c = canvas.Canvas(str(out), pagesize=A4)
        c.setFont('Helvetica', 11)
        y = h - 50
        for line in text.split('\n'):
            if y < 50:
                c.showPage()
                c.setFont('Helvetica', 11)
                y = h - 50
            c.drawString(50, y, line[:120])
            y -= 15
        c.save()

    def _conv_txt_to_docx(self, src: Path, out: Path):
        from docx import Document
        doc = Document()
        for line in src.read_text(encoding='utf-8').split('\n'):
            doc.add_paragraph(line)
        doc.save(str(out))

    # ═══════════════════════════════════════════════════════
    #  Image conversions
    # ═══════════════════════════════════════════════════════
    def _conv_png_to_jpg(self, src: Path, out: Path):
        from PIL import Image
        img = Image.open(src)
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        img.save(out, 'JPEG', quality=90)

    def _conv_jpg_to_png(self, src: Path, out: Path):
        from PIL import Image
        Image.open(src).save(out, 'PNG')

    def _conv_png_to_pdf(self, src: Path, out: Path):
        from PIL import Image
        img = Image.open(src)
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        img.save(out, 'PDF')

    _conv_jpg_to_pdf = _conv_png_to_pdf

    def _conv_png_to_txt(self, src: Path, out: Path):
        try:
            from PIL import Image
            import pytesseract
            text = pytesseract.image_to_string(Image.open(src), lang='chi_sim+eng')
            out.write_text(text, encoding='utf-8')
        except Exception:
            out.write_text(f'[图片: {src.name}] — 安装 Tesseract OCR 可识别图中文字', encoding='utf-8')

    _conv_jpg_to_txt = _conv_png_to_txt

    # ═══════════════════════════════════════════════════════
    #  DXF (CAD) conversions
    # ═══════════════════════════════════════════════════════
    def _conv_dxf_to_pdf(self, src: Path, out: Path):
        try:
            import ezdxf
            from ezdxf.addons.drawing import matplotlib
            doc = ezdxf.readfile(str(src))
            matplotlib.qsave(doc.modelspace(), str(out))
        except Exception:
            from reportlab.lib.pagesizes import A4
            from reportlab.pdfgen import canvas
            c = canvas.Canvas(str(out), pagesize=A4)
            c.drawString(50, 400, f'DXF file: {src.name}')
            c.drawString(50, 380, 'Install ezdxf + matplotlib for full CAD rendering')
            c.save()

    # ═══════════════════════════════════════════════════════
    #  Helpers
    # ═══════════════════════════════════════════════════════
    def _wrap_text(self, text, max_chars, canvas_obj):
        """Simple text wrapping."""
        words = text.split()
        lines = []
        current = ''
        for w in words:
            test = current + (' ' if current else '') + w
            if len(test) <= max_chars:
                current = test
            else:
                if current:
                    lines.append(current)
                current = w if len(w) <= max_chars else w[:max_chars]
        if current:
            lines.append(current)
        return lines or [text[:max_chars]]

    # ═══════════════════════════════════════════════════════
    #  LibreOffice (optional, for high-quality Office conv)
    # ═══════════════════════════════════════════════════════
    def _detect_libreoffice(self) -> bool:
        for cmd in ['soffice', 'libreoffice', 'soffice.exe']:
            found = shutil.which(cmd)
            if found:
                self._lo_cmd = found
                return True

        if os.name == 'nt':
            candidates = [
                r'C:\Program Files\LibreOffice\program\soffice.exe',
                r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
            ]
            try:
                import winreg
                for hive in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
                    for kp in [r'SOFTWARE\LibreOffice', r'SOFTWARE\WOW6432Node\LibreOffice']:
                        try:
                            with winreg.OpenKey(hive, kp) as key:
                                i = 0
                                while True:
                                    try:
                                        sub = winreg.EnumKey(key, i)
                                        with winreg.OpenKey(key, sub) as sk:
                                            pv, _ = winreg.QueryValueEx(sk, 'Path')
                                            lp = Path(pv) / 'program' / 'soffice.exe'
                                            if lp.exists():
                                                candidates.append(str(lp))
                                    except OSError:
                                        break
                                    i += 1
                        except OSError:
                            pass
            except Exception:
                pass
        else:
            candidates = [
                '/usr/bin/soffice', '/usr/local/bin/soffice',
                '/Applications/LibreOffice.app/Contents/MacOS/soffice',
                '/opt/libreoffice/program/soffice',
            ]

        for c in candidates:
            if os.path.exists(c):
                self._lo_cmd = c
                return True

        self._lo_cmd = None
        return False

    def _convert_lo(self, src: Path, dst_fmt: str, out_path: Path) -> Path:
        if not self.lo_available:
            raise RuntimeError('LibreOffice 未安装')

        out_dir = tempfile.mkdtemp(prefix='lo_')
        lo_dir = str(Path(self._lo_cmd).parent)
        lo_exe = self._lo_cmd

        fmt_map = {'pdf': 'pdf', 'docx': 'docx', 'xlsx': 'xlsx',
                    'pptx': 'pptx', 'txt': 'txt', 'dxf': 'dxf'}
        lo_fmt = fmt_map.get(dst_fmt, dst_fmt)

        if os.name == 'nt':
            cmd = f'cd /d "{lo_dir}" && "{lo_exe}" --headless --norestore --nofirststartwizard --convert-to {lo_fmt} --outdir "{out_dir}" "{src}"'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
        else:
            result = subprocess.run(
                [lo_exe, '--headless', '--norestore', '--nofirststartwizard',
                 '--convert-to', lo_fmt, '--outdir', out_dir, str(src)],
                capture_output=True, text=True, timeout=120, cwd=lo_dir,
            )

        if result.returncode != 0:
            raise RuntimeError(f'LO: {result.stderr[:200]}')

        expected = Path(out_dir) / f'{src.stem}.{dst_fmt}'
        if expected.exists():
            shutil.move(str(expected), str(out_path))
        else:
            found = list(Path(out_dir).glob(f'{src.stem}.*'))
            if found:
                shutil.move(str(found[0]), str(out_path))
            else:
                raise RuntimeError('LO 未生成输出文件')

        shutil.rmtree(out_dir, ignore_errors=True)
        return out_path
