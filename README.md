# DocForge — 文档格式批量转换器

🌐 简体中文 | English (upstream)

**全格式互转 · PDF 编辑器 · 批量处理 · 离线可用**

基于 Electron 构建的跨平台桌面应用，纯 Python 引擎驱动。支持 PDF / Word / Excel / PPT / 图片 / TXT / CAD 全格式批量互转，内置完整 Canvas PDF 编辑器——文本编辑、矩形标注、文字改色，所见即所得。LibreOffice 可选增强，不装也能正常运行。

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

---

## 📊 功能概览

| 🔄 格式转换 | ✂️ PDF 操作 | ✏️ PDF 编辑器 | 🖥️ 桌面体验 |
|-------------|-------------|---------------|-------------|
| PDF ↔ Word | 按页拆分 | 文本块编辑 | Electron 原生 |
| PDF ↔ Excel | 多文件合并 | 矩形标注 | macOS / Win / Linux |
| PDF ↔ PPT | 页面删除 | 文字改色 | 暗色模式 |
| PDF → TXT | 页面旋转 | 边框填充色 | 拖拽上传 |
| 图片互转 | 页面排序 | 橡皮擦 | 批量 ZIP 下载 |
| TXT → PDF/DOCX | | 滚轮缩放 | 桌面快捷方式 |
| CAD (DXF) → PDF | | | SSE 进度推送 |

**8 种格式 × 8 种格式 = 64 条转换路径**，全部纯 Python 引擎，无需联网。

---

## 🚀 快速开始

### 前置要求

| 软件 | 版本 | 必需 |
|------|------|------|
| Node.js | ≥ 18 | ✅ |
| Python | ≥ 3.10 | ✅ |
| LibreOffice | ≥ 7.4 | 可选 |

### 一键安装

```bat
# Windows — 双击运行
scripts\setup.bat
```

自动完成：检测 Node/Python → `npm install` → `pip install` → 检测 LibreOffice。

### 开发模式启动

```bat
scripts\dev.bat
```

### 构建 EXE 安装包

```bat
scripts\build.bat
```

构建完成后在 `dist\` 目录找到 `DocForge Setup 1.0.0.exe`，双击安装，桌面自动创建快捷方式。

---

## 🎯 功能详解

### 格式转换

拖拽文件到窗口 → 选择目标格式 → 点击「开始转换」→ 等待进度条完成 → 下载结果。

| 源格式 | 目标格式 | 引擎 |
|--------|----------|------|
| DOCX / XLSX / PPTX | PDF / TXT | `python-docx` + `openpyxl` + `python-pptx` + `reportlab` |
| PDF | TXT / DOCX | `pdfplumber` + `python-docx` |
| TXT | PDF / DOCX | `reportlab` + `python-docx` |
| PNG / JPG | PDF / PNG / JPG / TXT | `Pillow` + `pytesseract` |
| DXF | PDF | `ezdxf` |

> 安装 LibreOffice 后可获得更精确的 Office 格式排版保留效果。

### PDF 拆分 & 合并

- **拆分**：拖入 PDF → 输入范围如 `1-3,5,7-9`，留空则每页独立拆分
- **合并**：拖入多个 PDF → 点击合并 → 下载
- **页面操作**：拖入 PDF → 勾选页面缩略图 → 旋转 / 删除 / 导出

### 可编辑 PDF（WPS 级别）

拖入 PDF → 左侧缩略图选页 → Canvas 编辑器：

| 工具 | 操作 |
|------|------|
| **选择** | 点击文字块编辑文本 + 改色；点击矩形标注改边框/填充色 |
| **文字** | 工具栏选颜色 → 点画布任意位置 → 输入文字 |
| **矩形** | 工具栏选边框色+填充色 → 点两次画布（起点+终点）|
| **橡皮擦** | 点文字块删除文字；点矩形填充删除标注 |
| **滚轮缩放** | 画布区滚动 → 0.3× ~ 4.0× 等比缩放 |
| **保存** | 右上角「保存」→ 生成新 PDF |

---

## 🏗️ 项目结构

```
doc-forge/
├── main.js                    # Electron 主进程
├── preload.js                 # IPC 桥接
├── package.json               # 依赖 + electron-builder
├── renderer/                  # 前端 UI
│   ├── index.html             # macOS 风格三标签页
│   ├── css/style.css          # 设计系统 + 暗色模式
│   └── js/
│       ├── app.js             # 主控 + API
│       ├── converter.js       # 格式转换标签
│       ├── pdf-split.js       # PDF 拆分合并标签
│       └── pdf-editor.js      # Canvas PDF 编辑器
├── backend/                   # Python 引擎
│   ├── server.py              # Flask API（14 端点）
│   ├── engine/
│   │   ├── converter.py       # 全格式互转引擎
│   │   └── pdf_ops.py         # PDF 操作引擎
│   └── requirements.txt
├── scripts/
│   ├── setup.bat              # 一键安装环境
│   ├── dev.bat                # 开发启动
│   └── build.bat              # 构建 EXE
├── uploads/                   # 上传临时目录
└── outputs/                   # 转换结果
```

---

## 📡 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 + 格式列表 |
| `/api/formats` | GET | 支持格式矩阵 |
| `/api/upload` | POST | 上传文件（multipart） |
| `/api/convert` | POST | 启动批量转换任务 |
| `/api/task/<id>` | GET | 查询任务进度 |
| `/api/download/<id>` | GET | 下载单个结果 |
| `/api/download-all/<id>` | GET | 批量下载 ZIP |
| `/api/pdf/split` | POST | PDF 按页拆分 |
| `/api/pdf/merge` | POST | 多 PDF 合并 |
| `/api/pdf/delete-pages` | POST | 删除页面 |
| `/api/pdf/rotate-pages` | POST | 旋转页面 |
| `/api/pdf/reorder` | POST | 页面重排 |
| `/api/pdf/parse` | POST | 解析页面结构（编辑器） |
| `/api/pdf/save` | POST | 保存编辑结果 |
| `/api/pdf/render/<id>/<page>` | GET | 渲染页面为 PNG |

---

## 🛠️ 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 28 + electron-builder |
| 前端 | HTML5 Canvas + pdf.js + 原生 CSS 设计系统 |
| 后端 | Python Flask + pikepdf + PyPDF2 + pdfplumber |
| Office | python-docx + openpyxl + python-pptx + reportlab |
| 图像 | Pillow + pytesseract (OCR 可选) |
| CAD | ezdxf |
| 打包 | PyInstaller (Python → exe) + NSIS 安装器 |

---

## 📦 从源码构建

```bash
# 1. 克隆仓库
git clone https://github.com/chale0110/doc-forge.git
cd doc-forge

# 2. 安装依赖
scripts\setup.bat          # Windows
# chmod +x scripts/setup.sh && ./scripts/setup.sh   # macOS/Linux

# 3. 开发运行
scripts\dev.bat

# 4. 打包 EXE
scripts\build.bat          # 输出在 dist\ 目录
```

---


<p align="center">
  <sub>Built with Electron + Python · macOS design system · Dark mode ready</sub>
</p>
