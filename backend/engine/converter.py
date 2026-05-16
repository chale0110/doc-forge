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
        self.upload_dir = Path(upload_dir)
        self.output_dir = Path(output_dir)
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
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY

        doc = Document(src)
        w, h = A4
        pw = w - 100  # page width minus margins

        # Build story
        story = []
        styles = getSampleStyleSheet()

        for para in doc.paragraphs:
            text = para.text
            if not text and not para.runs:
                story.append(Spacer(1, 10))
                continue

            # Determine alignment
            alignment_map = {
                WD_ALIGN_PARAGRAPH.LEFT: TA_LEFT,
                WD_ALIGN_PARAGRAPH.CENTER: TA_CENTER,
                WD_ALIGN_PARAGRAPH.RIGHT: TA_RIGHT,
                WD_ALIGN_PARAGRAPH.JUSTIFY: TA_JUSTIFY,
            }
            align = alignment_map.get(para.alignment, TA_LEFT)

            # Determine if bold
            is_bold = False
            for run in para.runs:
                if run.bold:
                    is_bold = True
                    break

            style_name = 'docx-para-b' if is_bold else 'docx-para'
            if style_name not in styles:
                styles.add(ParagraphStyle(
                    style_name,
                    fontName='Helvetica' + ('-Bold' if is_bold else ''),
                    fontSize=11,
                    leading=15,
                    alignment=align,
                ))

            if not text.strip():
                story.append(Spacer(1, 6))
                continue

            # Use paragraph rendering with proper text wrapping
            p = Paragraph(text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), styles[style_name])
            story.append(p)
            story.append(Spacer(1, 2))

        # Build PDF
        doc_builder = SimpleDocTemplate(str(out), pagesize=A4,
                                         leftMargin=50, rightMargin=50,
                                         topMargin=40, bottomMargin=40)
        doc_builder.build(story)

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
        from openpyxl.utils import get_column_letter
        from reportlab.lib.pagesizes import A4, A3, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_CENTER, TA_LEFT

        wb = load_workbook(src, data_only=True)
        ws = wb.active

        # Choose page size and orientation
        if ws.max_column > 10:
            pg = landscape(A3)
        elif ws.max_column > 8:
            pg = A3
        else:
            pg = A4

        pw = pg[0] - 40  # usable width with margins
        ph = pg[1] - 40

        styles = getSampleStyleSheet()
        cell_style = ParagraphStyle('cell-style', fontName='Helvetica', fontSize=8, leading=10, alignment=TA_LEFT)
        header_style = ParagraphStyle('header-style', fontName='Helvetica-Bold', fontSize=9, leading=11, alignment=TA_CENTER)

        # Build table data
        data = []
        max_row = min(ws.max_row, 500)
        for row_idx, row in enumerate(ws.iter_rows(min_row=1, max_row=max_row, values_only=True)):
            row_data = []
            for val in row:
                text = str(val) if val is not None else ''
                text = text[:200].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                if row_idx == 0:
                    row_data.append(Paragraph(text, header_style))
                else:
                    row_data.append(Paragraph(text, cell_style))
            if row_data:
                data.append(row_data)

        if not data:
            data = [['(空表格)']]

        # Calculate column widths based on content
        col_count = len(data[0])
        base_w = pw / max(col_count, 1)
        col_widths = [max(base_w, mm * 20) for _ in range(col_count)]

        # Build table
        tbl = Table(data, colWidths=col_widths, repeatRows=1)

        # Table style
        tbl_style = TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, colors.Color(0.8, 0.8, 0.8)),
            ('BACKGROUND', (0, 0), (-1, 0), colors.Color(0.9, 0.9, 0.9)),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.Color(0.97, 0.97, 0.98)]),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ])
        tbl.setStyle(tbl_style)

        story = [tbl]

        doc_builder = SimpleDocTemplate(str(out), pagesize=pg,
                                         leftMargin=20, rightMargin=20,
                                         topMargin=20, bottomMargin=20)
        doc_builder.build(story)

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
        from pptx.util import Inches
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Frame, PageTemplate, PageBreak
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_LEFT, TA_CENTER

        prs = Presentation(src)
        w, h = landscape(A4)  # PPTX is often landscape

        styles = getSampleStyleSheet()
        title_style = ParagraphStyle('slide-title', fontName='Helvetica-Bold', fontSize=18, leading=22, alignment=TA_LEFT)
        body_style = ParagraphStyle('slide-body', fontName='Helvetica', fontSize=12, leading=16, alignment=TA_LEFT)

        story = []

        for slide_num, slide in enumerate(prs.slides):
            if slide_num > 0:
                story.append(PageBreak())

            # Slide title
            has_title = False
            for shape in slide.shapes:
                if shape.is_placeholder and shape.placeholder_format.type == 1:  # TITLE
                    t = shape.text.strip()
                    if t:
                        story.append(Paragraph(t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), title_style))
                        story.append(Spacer(1, 12))
                        has_title = True
                    break

            if not has_title:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        for para in shape.text_frame.paragraphs:
                            t = para.text.strip()
                            if t and len(t) > 2:
                                story.append(Paragraph(t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), title_style))
                                story.append(Spacer(1, 12))
                                break
                        break

            # Slide body
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = para.text.strip()
                        if t and not (has_title and para is slide.shapes[0].text_frame.paragraphs[0]):
                            story.append(Paragraph(t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), body_style))
                            story.append(Spacer(1, 6))

            story.append(Spacer(1, 20))

        if not story:
            story.append(Paragraph('(空演示文稿)', body_style))

        doc_builder = SimpleDocTemplate(str(out), pagesize=(w, h),
                                         leftMargin=50, rightMargin=50,
                                         topMargin=40, bottomMargin=40)
        doc_builder.build(story)

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
        from docx.shared import Pt

        doc = Document()

        with pdfplumber.open(src) as pdf:
            for page_num, page in enumerate(pdf.pages):
                if page_num > 0:
                    doc.add_page_break()

                # Try to extract text with layout
                t = page.extract_text(layout=True, x_tolerance=3, y_tolerance=3)
                if t:
                    for line in t.split('\n'):
                        line = line.strip()
                        if line:
                            p = doc.add_paragraph(line)
                            # Use small font to match PDF look
                            for run in p.runs:
                                run.font.size = Pt(11)
                else:
                    # Fallback: extract without layout
                    t2 = page.extract_text()
                    if t2:
                        doc.add_paragraph(t2.strip())

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
