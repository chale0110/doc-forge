"""
DocForge PDF 操作引擎

功能:
  - 按页拆分 / 多文件合并
  - 页面删除 / 旋转 / 重排
  - 页面结构解析 (文本块坐标 + 图片)
  - 页面渲染为图片
  - 编辑回写 (文本修改 / 图片替换 / 标注)
"""

import os
import io
import uuid
import tempfile
import subprocess
from pathlib import Path
from typing import List, Dict, Optional, Tuple

import pikepdf
from PyPDF2 import PdfReader, PdfWriter, PdfMerger
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.units import mm
from PIL import Image, ImageDraw, ImageFont


class PDFOps:
    """PDF 拆分 / 合并 / 编辑"""

    def __init__(self, upload_dir: Path, output_dir: Path):
        self.upload_dir = Path(upload_dir)
        self.output_dir = Path(output_dir)

    def _out_path(self, prefix: str = 'output') -> Path:
        name = f'{prefix}_{uuid.uuid4().hex[:8]}.pdf'
        return self.output_dir / name

    # ═══════════════════════════════════════════════════════
    #  Split
    # ═══════════════════════════════════════════════════════
    def split_pdf(self, src_path: str, ranges: str = None) -> List[Path]:
        """
        Split a PDF. If ranges is None, split every page.
        ranges: "1-3,5,7-9" → page numbers 1-indexed.
        """
        reader = PdfReader(src_path)
        total = len(reader.pages)

        # Parse ranges
        if ranges:
            page_sets = self._parse_ranges(ranges, total)
        else:
            # Split every page individually
            page_sets = [[i] for i in range(total)]

        out_files = []
        for i, pages in enumerate(page_sets):
            writer = PdfWriter()
            for p in pages:
                writer.add_page(reader.pages[p])
            out = self._out_path(f'split_{i+1}')
            writer.write(str(out))
            out_files.append(out)

        return out_files

    def _parse_ranges(self, ranges_str: str, total: int) -> List[List[int]]:
        """Parse '1-3,5,7-9' into [[0,1,2], [4], [6,7,8]] (0-indexed)."""
        result = []
        for part in ranges_str.split(','):
            part = part.strip()
            if '-' in part:
                a, b = part.split('-', 1)
                start = max(0, int(a) - 1)
                end = min(total, int(b))
                result.append(list(range(start, end)))
            else:
                p = int(part) - 1
                if 0 <= p < total:
                    result.append([p])
        return result

    # ═══════════════════════════════════════════════════════
    #  Merge
    # ═══════════════════════════════════════════════════════
    def merge_pdfs(self, paths: List[str]) -> Path:
        merger = PdfMerger()
        for p in paths:
            merger.append(p)
        out = self._out_path('merged')
        merger.write(str(out))
        merger.close()
        return out

    # ═══════════════════════════════════════════════════════
    #  Delete Pages
    # ═══════════════════════════════════════════════════════
    def delete_pages(self, src_path: str, pages: List[int]) -> Path:
        """Delete pages by 0-indexed numbers."""
        reader = PdfReader(src_path)
        writer = PdfWriter()
        for i, page in enumerate(reader.pages):
            if i not in pages:
                writer.add_page(page)
        out = self._out_path('deleted')
        writer.write(str(out))
        return out

    # ═══════════════════════════════════════════════════════
    #  Rotate Pages
    # ═══════════════════════════════════════════════════════
    def rotate_pages(self, src_path: str, rotations: Dict[int, int]) -> Path:
        """Rotate pages. rotations: {0: 90, 2: 180} (0-indexed, degrees)."""
        reader = PdfReader(src_path)
        writer = PdfWriter()
        for i, page in enumerate(reader.pages):
            if i in rotations:
                page.rotate(rotations[i])
            writer.add_page(page)
        out = self._out_path('rotated')
        writer.write(str(out))
        return out

    # ═══════════════════════════════════════════════════════
    #  Reorder Pages
    # ═══════════════════════════════════════════════════════
    def reorder_pages(self, src_path: str, order: List[int]) -> Path:
        """Reorder pages by 0-indexed new order."""
        reader = PdfReader(src_path)
        writer = PdfWriter()
        for i in order:
            if 0 <= i < len(reader.pages):
                writer.add_page(reader.pages[i])
        out = self._out_path('reordered')
        writer.write(str(out))
        return out

    # ═══════════════════════════════════════════════════════
    #  Parse Page Structure (for Editor)
    # ═══════════════════════════════════════════════════════
    def parse_page(self, src_path: str, page_num: int = 0) -> dict:
        """
        Extract text blocks and image info from a PDF page.
        Returns structured data for the editor.
        """
        import pdfplumber

        result = {
            'page': page_num,
            'width': 595,   # default A4 in points
            'height': 842,
            'text_blocks': [],
            'images': [],
            'total_pages': 0,
        }

        with pdfplumber.open(src_path) as pdf:
            result['total_pages'] = len(pdf.pages)
            if page_num >= len(pdf.pages):
                return result

            page = pdf.pages[page_num]
            result['width'] = float(page.width)
            result['height'] = float(page.height)

            # Extract words with positions
            words = page.extract_words(
                keep_blank_chars=True,
                x_tolerance=3,
                y_tolerance=3,
                extra_attrs=['fontname', 'size']
            )

            # Group words into text blocks (lines)
            blocks = self._words_to_blocks(words)

            result['text_blocks'] = [
                {
                    'id': i,
                    'x': b['x'],
                    'y': b['y'],  # Already top-left Y (from w['top'])
                    'width': b['width'],
                    'height': b['height'],
                    'text': b['text'],
                    'font': b.get('font', 'unknown'),
                    'size': b.get('size', 12),
                    'characters': b.get('characters', []),
                }
                for i, b in enumerate(blocks)
            ]

            # Extract image info
            if hasattr(page, 'images'):
                for i, img in enumerate(page.images):
                    result['images'].append({
                        'id': f'img_{i}',
                        'x': img.get('x0', 0),
                        'y': result['height'] - img.get('y1', 0),
                        'width': img.get('width', 0),
                        'height': img.get('height', 0),
                        'name': img.get('name', f'image_{i}'),
                    })

        return result

    def _words_to_blocks(self, words: list) -> list:
        """Group words into line blocks based on Y proximity."""
        if not words:
            return []

        # Sort by y then x
        words_sorted = sorted(words, key=lambda w: (round(w['top'], 1), w['x0']))

        blocks = []
        current_block = {
            'words': [words_sorted[0]],
            'x': words_sorted[0]['x0'],
            'y': words_sorted[0]['top'],
            'width': words_sorted[0]['x1'] - words_sorted[0]['x0'],
            'height': words_sorted[0]['bottom'] - words_sorted[0]['top'],
        }

        for w in words_sorted[1:]:
            # Same line if y difference < 5 points
            if abs(w['top'] - current_block['y']) < 5:
                current_block['words'].append(w)
                current_block['x'] = min(current_block['x'], w['x0'])
                current_block['width'] = max(
                    current_block['x'] + current_block['width'],
                    w['x1']
                ) - current_block['x']
                current_block['height'] = max(
                    current_block['height'],
                    w['bottom'] - current_block['y']
                )
            else:
                # Finish current block
                blocks.append(self._build_block(current_block))
                # Start new
                current_block = {
                    'words': [w],
                    'x': w['x0'],
                    'y': w['top'],
                    'width': w['x1'] - w['x0'],
                    'height': w['bottom'] - w['top'],
                }

        blocks.append(self._build_block(current_block))
        return blocks

    def _build_block(self, block: dict) -> dict:
        words = block['words']
        text = ' '.join(w.get('text', '') for w in words)
        fonts = [w.get('fontname', 'unknown') for w in words if w.get('fontname')]
        sizes = [w.get('size', 12) for w in words if w.get('size')]

        # Character-level data
        chars = []
        for w in words:
            w_text = w.get('text', '')
            w_x0 = w.get('x0', 0)
            if w_text:
                char_w = (w.get('x1', w_x0) - w_x0) / len(w_text)
                for ci, ch in enumerate(w_text):
                    chars.append({
                        'char': ch,
                        'x': w_x0 + ci * char_w,
                        'width': char_w,
                    })

        return {
            'x': block['x'],
            'y': block['y'],
            'width': block['width'],
            'height': block['height'],
            'text': text,
            'font': fonts[0] if fonts else 'unknown',
            'size': max(sizes) if sizes else 12,
            'characters': chars,
        }

    # ═══════════════════════════════════════════════════════
    #  Render Page as Image (for Editor Canvas)
    # ═══════════════════════════════════════════════════════
    def render_page(self, src_path: str, page_num: int = 0) -> Path:
        """Render a PDF page to PNG. Uses pdf2image if available, else fallback."""
        try:
            from pdf2image import convert_from_path
            images = convert_from_path(
                src_path,
                first_page=page_num + 1,
                last_page=page_num + 1,
                dpi=150
            )
            if images:
                out = self.output_dir / f'render_{uuid.uuid4().hex[:8]}.png'
                images[0].save(str(out), 'PNG')
                return out
        except Exception:
            pass

        # Fallback: generate a placeholder
        return self._render_placeholder(page_num)

    def _render_placeholder(self, page_num: int) -> Path:
        """Generate a placeholder image when pdf2image is unavailable."""
        out = self.output_dir / f'render_{uuid.uuid4().hex[:8]}.png'
        img = Image.new('RGB', (794, 1123), color='white')  # A4 @ 96dpi
        draw = ImageDraw.Draw(img)
        draw.rectangle([50, 50, 744, 1073], outline='#ccc', width=1)
        draw.text((350, 540), f'Page {page_num + 1}', fill='#999')
        draw.text((250, 580), '安装 poppler 以启用 PDF 渲染', fill='#999')
        img.save(str(out), 'PNG')
        return out

    # ═══════════════════════════════════════════════════════
    #  Apply Edits (Editor Save)
    # ═══════════════════════════════════════════════════════
    def apply_edits(self, src_path: str, edits: List[dict]) -> Path:
        """
        Apply user edits to PDF.
        edits: list of edit operations:
          - {type: 'text', page: 0, block_id: 0, new_text: '...'}
          - {type: 'image_replace', page: 0, img_id: 'img_0', new_image: 'file_id'}
          - {type: 'add_text', page: 0, x: 100, y: 200, text: '...', size: 12}
          - {type: 'add_rect', page: 0, x, y, w, h, color: '#ff0000'}
          - {type: 'delete_page', page: 0}
        """
        pdf = pikepdf.open(src_path)
        total_pages = len(pdf.pages)

        pages_to_delete = set()

        for edit in edits:
            etype = edit.get('type')
            page_num = edit.get('page', 0)

            if etype == 'delete_page':
                pages_to_delete.add(page_num)

            elif etype == 'add_text':
                if page_num < total_pages:
                    self._add_text_annotation(
                        pdf, page_num,
                        edit.get('x', 100),
                        edit.get('y', 100),
                        edit.get('text', ''),
                        edit.get('size', 12),
                        edit.get('color', '#000000'),
                    )

            elif etype == 'add_rect':
                if page_num < total_pages:
                    self._add_rect_annotation(
                        pdf, page_num,
                        edit.get('x', 100),
                        edit.get('y', 100),
                        edit.get('w', 100),
                        edit.get('h', 50),
                        edit.get('color', '#ff0000'),
                        edit.get('fill', '#ffffff'),
                        edit.get('opacity', 100),
                    )

            elif etype == 'add_highlight':
                if page_num < total_pages:
                    self._add_highlight_annotation(
                        pdf, page_num,
                        edit.get('x', 100),
                        edit.get('y', 100),
                        edit.get('width', 200),
                        edit.get('height', 20),
                        edit.get('color', '#FFD700'),
                    )

            elif etype == 'text':
                if page_num < total_pages:
                    self._overlay_text(
                        pdf, page_num,
                        edit.get('x', 100),
                        edit.get('y', 100),
                        edit.get('width', 200),
                        edit.get('height', 20),
                        edit.get('new_text', ''),
                        edit.get('size', 12),
                        edit.get('color', '#000000'),
                    )

        # Delete pages in reverse order
        if pages_to_delete:
            for p in sorted(pages_to_delete, reverse=True):
                if p < len(pdf.pages):
                    del pdf.pages[p]

        out = self._out_path('edited')
        pdf.save(str(out))
        pdf.close()
        return out

    def _add_text_annotation(self, pdf, page_num: int, x: float, y: float,
                              text: str, size: int, color: str = '#000000'):
        """Add a free-text annotation to a page."""
        page = pdf.pages[page_num]
        page_height = float(page.MediaBox[3]) if '/MediaBox' in page else 842
        pdf_y = page_height - y

        # Convert hex color to RGB array for PDF
        hex_c = color.lstrip('#')
        r, g, b = (int(hex_c[i:i+2], 16) / 255 for i in (0, 2, 4)) if len(hex_c) == 6 else (0, 0, 0)

        annotation = pikepdf.Dictionary({
            '/Type': '/Annot',
            '/Subtype': '/FreeText',
            '/Rect': pikepdf.Array([x, pdf_y - 20, x + 400, pdf_y + 10]),
            '/Contents': text,
            '/DA': f'{r:.2f} {g:.2f} {b:.2f} rg /Helv {size} Tf',
            '/C': pikepdf.Array([r, g, b]),
            '/F': 4,
            '/Border': pikepdf.Array([0, 0, 0]),
        })

        if '/Annots' not in page:
            page['/Annots'] = pikepdf.Array()
        page['/Annots'].append(annotation)

    def _add_rect_annotation(self, pdf, page_num: int, x: float, y: float,
                               w: float, h: float, color: str, fill: str = '#ffffff',
                               opacity: int = 100):
        """Add a rectangle annotation with optional fill and opacity (0-100)."""
        page = pdf.pages[page_num]
        page_height = float(page.MediaBox[3]) if '/MediaBox' in page else 842
        pdf_y = page_height - y

        hex_c = color.lstrip('#')
        r, g, b = tuple(int(hex_c[i:i+2], 16) / 255 for i in (0, 2, 4)) if len(hex_c) == 6 else (1, 0, 0)

        hex_f = fill.lstrip('#')
        rf, gf, bf = tuple(int(hex_f[i:i+2], 16) / 255 for i in (0, 2, 4)) if len(hex_f) == 6 else (1, 1, 1)

        # Opacity: PDF /CA (0.0 - 1.0), default 1.0 (fully opaque)
        ca = max(0.0, min(1.0, opacity / 100.0))

        ann = {
            '/Type': '/Annot',
            '/Subtype': '/Square',
            '/Rect': pikepdf.Array([x, pdf_y - h, x + w, pdf_y]),
            '/C': pikepdf.Array([r, g, b]),
            '/F': 4,
            '/Border': pikepdf.Array([0, 0, 1]),
            '/CA': ca,  # Transparency
        }
        # Interior color (fill)
        if ca > 0 and fill.lower() not in ('#ffffff', '#fff', 'white', '', 'none'):
            ann['/IC'] = pikepdf.Array([rf, gf, bf])

        annotation = pikepdf.Dictionary(ann)

        if '/Annots' not in page:
            page['/Annots'] = pikepdf.Array()
        page['/Annots'].append(annotation)

    def _add_highlight_annotation(self, pdf, page_num: int, x: float, y: float,
                                    width: float, height: float, color: str = '#FFD700'):
        """Add a semi-transparent highlight rectangle (like a marker over text)."""
        page = pdf.pages[page_num]
        page_height = float(page.MediaBox[3]) if '/MediaBox' in page else 842
        pdf_y = page_height - y

        # Parse color
        hex_c = color.lstrip('#')
        r, g, b = tuple(int(hex_c[i:i+2], 16) / 255 for i in (0, 2, 4)) if len(hex_c) == 6 else (1, 1, 0)

        ann = {
            '/Type': '/Annot',
            '/Subtype': '/Square',
            '/Rect': pikepdf.Array([x, pdf_y - height, x + width, pdf_y]),
            '/C': pikepdf.Array([r, g, b]),
            '/F': 4,
            '/Border': pikepdf.Array([0, 0, 0]),
            '/CA': 0.4,  # Semi-transparent
            '/IC': pikepdf.Array([r, g, b]),
        }

        annotation = pikepdf.Dictionary(ann)

        if '/Annots' not in page:
            page['/Annots'] = pikepdf.Array()
        page['/Annots'].append(annotation)

    def _overlay_text(self, pdf, page_num: int, x: float, y: float,
                        width: float, height: float, new_text: str, size: int,
                        color: str = '#000000'):
        """Overlay new text on top of old text area using content stream injection."""
        page = pdf.pages[page_num]
        page_height = float(page.MediaBox[3]) if '/MediaBox' in page else 842
        pdf_y = page_height - y

        # Convert hex to PDF RGB (0-1 range)
        hex_c = color.lstrip('#')
        r, g, b = (int(hex_c[i:i+2], 16) / 255 for i in (0, 2, 4)) if len(hex_c) >= 6 else (0, 0, 0)

        overlay_content = (
            f'q '
            f'1 1 1 rg {x} {pdf_y - height} {width} {height} re f '
            f'{r:.3f} {g:.3f} {b:.3f} rg '
            f'BT /Helv {size} Tf {x + 2} {pdf_y - height + 3} Td '
            f'({new_text}) Tj ET '
            f'Q'
        )

        overlay_stream = pikepdf.Stream(pdf, overlay_content.encode('ascii'))
        page.contents_add(overlay_stream, prepend=False)
