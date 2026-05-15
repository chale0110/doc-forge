# DocForge — 文档格式批量转换器

为开发者提供文档格式转换、PDF 编辑和批量处理的一站式解决方案。

- 基于 Electron 构建的跨平台桌面应用
- 支持多平台运行，包括 Windows、macOS 和 Linux
- 全格式互转引擎：PDF / Word / Excel / PPT / 图片 / TXT / CAD 任意方向批量转换
- 完整的 PDF 编辑器：文本块编辑、标注、图片替换，Canvas 所见即所得
- PDF 拆分合并：按页拆分、多文件合并、页面删除/旋转/排序
- 拖拽式文件管理，实时转换进度，批量 ZIP 下载
- 集成 LibreOffice 引擎 + Python 生态，支持离线本地处理

---

## 前置依赖

| 依赖 | 说明 | 必需 |
|------|------|------|
| **Node.js ≥ 18** | Electron 运行时 | ✅ |
| **Python ≥ 3.10** | 后端引擎 | ✅ |
| **LibreOffice ≥ 7.4** | Office 格式互转核心 | ✅ |
| Tesseract OCR | 图片文字识别 | 可选 |
| Poppler | PDF 页面渲染为图片 | 可选 |

### 安装 LibreOffice

- **Windows**: [libreoffice.org/download](https://www.libreoffice.org/download/)
- **macOS**: `brew install --cask libreoffice`
- **Linux**: `sudo apt install libreoffice` 或 `sudo dnf install libreoffice`

### 安装可选依赖

```bash
# OCR
# Windows: https://github.com/UB-Mannheim/tesseract/wiki
# macOS: brew install tesseract
# Linux: sudo apt install tesseract-ocr tesseract-ocr-chi-sim

# PDF 渲染
# macOS: brew install poppler
# Linux: sudo apt install poppler-utils
```

## 快速开始

```bash
# 1. 进入项目目录
cd doc-forge

# 2. 安装 Node 依赖
npm install

# 3. 创建 Python 虚拟环境 & 安装后端依赖
python -m venv backend/venv
source backend/venv/bin/activate  # Windows: backend\venv\Scripts\activate
pip install -r backend/requirements.txt

# 4. 启动开发模式
npm run dev
```

## 项目结构

```
doc-forge/
├── main.js                    # Electron 主进程，启动 Flask 子进程
├── preload.js                 # IPC 桥接（暴露 electronAPI）
├── package.json               # Electron + electron-builder 配置
├── renderer/                  # 前端 UI
│   ├── index.html             # 主页面（三标签页布局）
│   ├── css/style.css
│   └── js/
│       ├── app.js             # 主控制器 + API 封装
│       ├── converter.js       # 格式转换标签页
│       ├── pdf-split.js       # PDF 拆分合并标签页
│       └── pdf-editor.js      # PDF Canvas 编辑器
├── backend/                   # Python 引擎
│   ├── server.py              # Flask API 服务
│   ├── engine/
│   │   ├── converter.py       # 全格式转换引擎
│   │   └── pdf_ops.py         # PDF 操作引擎
│   └── requirements.txt
├── uploads/                   # 上传临时目录
├── outputs/                   # 转换结果输出
└── build/                     # electron-builder 资源
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查、格式列表 |
| `/api/formats` | GET | 支持的输入/输出格式矩阵 |
| `/api/upload` | POST | 上传文件（multipart） |
| `/api/convert` | POST | 启动批量转换任务 |
| `/api/task/<id>` | GET | 查询任务进度 |
| `/api/download/<id>` | GET | 下载单个文件 |
| `/api/download-all/<id>` | GET | 批量下载 ZIP |
| `/api/pdf/split` | POST | PDF 按页拆分 |
| `/api/pdf/merge` | POST | 多 PDF 合并 |
| `/api/pdf/delete-pages` | POST | 删除指定页面 |
| `/api/pdf/rotate-pages` | POST | 旋转指定页面 |
| `/api/pdf/reorder` | POST | 页面重排 |
| `/api/pdf/parse` | POST | 解析 PDF 页面结构（编辑器用） |
| `/api/pdf/save` | POST | 保存编辑后的 PDF |
| `/api/pdf/render/<id>/<page>` | GET | 渲染页面为 PNG |

## 转换矩阵

| 源 \\ 目标 | PDF | DOCX | XLSX | PPTX | PNG | JPG | TXT | DXF |
|-----------|-----|------|------|------|-----|-----|-----|-----|
| **PDF**   | — | LO | LO | LO | LO | LO | LO | LO |
| **DOCX**  | LO | — | LO | LO | △ | △ | LO | △ |
| **XLSX**  | LO | LO | — | LO | △ | △ | CSV | △ |
| **PPTX**  | LO | LO | LO | — | △ | △ | LO | △ |
| **PNG**   | PIL | △ | — | △ | — | PIL | OCR | △ |
| **JPG**   | PIL | △ | — | △ | PIL | — | OCR | △ |
| **TXT**   | RL | △ | — | — | — | — | — | — |
| **DXF**   | LO | △ | — | — | — | — | — | — |

> LO = LibreOffice &nbsp;|&nbsp; PIL = Pillow &nbsp;|&nbsp; RL = ReportLab &nbsp;|&nbsp; △ = 间接路径（经 PDF 中转）

## 打包

```bash
npm run build:win    # Windows 便携版
npm run build:mac    # macOS DMG
npm run build:linux  # Linux AppImage
```

## 技术栈

- **前端**: Electron + HTML5 Canvas + pdf.js
- **后端**: Python Flask + LibreOffice UNO API
- **PDF**: pikepdf + PyPDF2 + pdfplumber + reportlab
- **Office**: python-docx + openpyxl + python-pptx
- **图像**: Pillow + pytesseract (OCR)
- **CAD**: ezdxf

## License

MIT
