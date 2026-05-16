const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let pythonProcess;
const BACKEND_PORT = 17520;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_DEV = process.argv.includes('--dev');

// ── Python Backend ───────────────────────────────────────
function findPython() {
  if (!IS_WIN) return 'python3';
  // Windows: try py launcher first, then python
  const { execSync } = require('child_process');
  for (const cmd of ['py', 'python', 'python3']) {
    try { execSync(`where ${cmd}`, { stdio: 'ignore' }); return cmd; } catch {}
  }
  return 'python'; // fallback, will fail with clear error
}

function getBackendPath() {
  if (IS_DEV) {
    return {
      cmd: findPython(),
      args: ['server.py'],
      cwd: path.join(__dirname, 'backend'),
    };
  }
  // Packaged mode
  const backendDir = path.join(process.resourcesPath, 'backend');
  const exeName = IS_WIN ? 'server.exe' : 'server';
  return {
    cmd: path.join(backendDir, exeName),
    args: [],
    cwd: backendDir,
  };
}

function startPythonBackend() {
  const { cmd, args, cwd } = getBackendPath();

  // Pass user data dir so uploads/outputs go to a writable location
  const env = {
    ...process.env,
    PORT: String(BACKEND_PORT),
    DOCFORGE_DATA_DIR: app.getPath('userData'),
  };

  pythonProcess = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,  // Don't show console window on Windows
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Python ERR] ${data.toString().trim()}`);
  });

  pythonProcess.on('error', (err) => {
    console.error('Failed to launch backend:', err.message);
  });

  pythonProcess.on('close', (code) => {
    console.log(`[Python] exited code=${code}`);
  });
}

function waitForBackend(retries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(`http://127.0.0.1:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else if (retries > 0) { retries--; setTimeout(attempt, 800); }
        else reject(new Error('Backend timeout'));
      }).on('error', () => {
        if (retries > 0) { retries--; setTimeout(attempt, 800); }
        else reject(new Error('Backend timeout'));
      });
    };
    attempt();
  });
}

// ── Window ───────────────────────────────────────────────
function createWindow() {
  const winOpts = {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DocForge',
    backgroundColor: IS_MAC ? '#00000000' : '#f5f5f7',
    show: false,  // Show after ready to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      zoomFactor: 1.0,    // Lock browser zoom — we handle PDF zoom ourselves
    },
  };

  if (IS_MAC) {
    winOpts.titleBarStyle = 'hiddenInset';
    winOpts.vibrancy = 'sidebar';
    winOpts.visualEffectState = 'active';
  }

  mainWindow = new BrowserWindow(winOpts);

  if (IS_WIN) {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Lock browser zoom — we handle PDF zoom ourselves in JS
    mainWindow.webContents.setZoomFactor(1.0);
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.handle('select-files', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: options?.filters || [
      { name: 'Supported Formats', extensions: [
        'pdf','doc','docx','xls','xlsx','ppt','pptx',
        'png','jpg','jpeg','gif','bmp','tiff','txt','csv','dxf','dwg'
      ]}
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-backend-port', () => BACKEND_PORT);
ipcMain.handle('get-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

// ── Lifecycle ────────────────────────────────────────────
app.whenReady().then(async () => {
  startPythonBackend();
  try {
    await waitForBackend();
    console.log('Backend ready');
  } catch (e) {
    console.error('Backend start failed:', e.message);
    // Still open window — user will see connection errors in UI
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) pythonProcess.kill();
});
