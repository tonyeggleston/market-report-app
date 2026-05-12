import { app, BrowserWindow, ipcMain, shell, clipboard, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, isSetupComplete } from './config.js';
import { initDb } from '../db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let pendingReportData = null;
let currentListingAddress = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Market Report Generator',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const setupDone = isSetupComplete();
  const page = setupDone ? 'dashboard.html' : 'setup.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', page));
}

app.whenReady().then(() => {
  try {
    initDb();
  } catch (err) {
    dialog.showErrorBox(
      'Database Error',
      `The app couldn't create its database. This usually means the install folder has a permissions issue.\n\n${err.message}`
    );
    app.quit();
    return;
  }
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

function friendlyError(err) {
  const msg = err.message || String(err);

  if (msg.includes('login fields'))
    return 'Could not find the login form on this page. The website layout may have changed — let Tony know.';
  if (msg.includes('Navigation timeout') || msg.includes('Timeout'))
    return 'The website took too long to load. Check your internet connection and try again.';
  if (msg.includes('net::ERR_'))
    return 'Could not connect to the website. Check your internet connection and try again.';
  if (msg.includes('OpenRouter'))
    return `AI service error: ${msg}. Check your API key in Settings.`;
  if (msg.includes('Chromium'))
    return 'The built-in browser could not start. Try reinstalling the app, or let Tony know.';

  return msg;
}

// Sensitive fields that should never be sent to the renderer
const SENSITIVE_FIELDS = ['mlsPassword', 'brokerBayPassword', 'openrouterApiKey'];

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => {
    const config = getConfig();
    if (!config) return null;
    // Strip passwords/keys — renderer gets empty strings for sensitive fields
    const safe = { ...config };
    for (const field of SENSITIVE_FIELDS) {
      if (safe[field]) safe[field] = '';
    }
    return safe;
  });

  ipcMain.handle('config:save', (_event, config) => {
    // If renderer sent empty sensitive fields, preserve existing values
    const existing = getConfig();
    if (existing) {
      for (const field of SENSITIVE_FIELDS) {
        if (!config[field] && existing[field]) {
          config[field] = existing[field];
        }
      }
    }
    saveConfig(config);
    return { ok: true };
  });

  ipcMain.handle('config:isSetupComplete', () => {
    return isSetupComplete();
  });

  ipcMain.handle('setup:complete', (_event, config) => {
    saveConfig(config);
    mainWindow.loadFile(
      path.join(__dirname, '..', 'renderer', 'dashboard.html')
    );
    return { ok: true };
  });

  ipcMain.handle('report:run', async (_event, listingAddress) => {
    try {
      const { runReport } = await import('../scrapers/orchestrator.js');

      currentListingAddress = listingAddress;

      const result = await runReport(listingAddress, (step, detail) => {
        mainWindow.webContents.send('report:progress', { step, detail });
      });

      if (result.needsReview) {
        pendingReportData = result.reportData;
        return { needsReview: true };
      }

      return result;
    } catch (err) {
      const friendly = friendlyError(err);
      mainWindow.webContents.send('report:progress', {
        step: 'Error',
        detail: friendly,
      });
      throw new Error(friendly);
    }
  });

  ipcMain.handle('review:open', () => {
    mainWindow.loadFile(
      path.join(__dirname, '..', 'renderer', 'review.html')
    );
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('review:data', pendingReportData);
    });
    return { ok: true };
  });

  ipcMain.handle('review:finalize', async (_event, overrides, descEdits) => {
    if (!pendingReportData || !currentListingAddress) {
      throw new Error('No report data to finalize. Try running the report again.');
    }

    try {
      const { finalizeReport } = await import('../scrapers/orchestrator.js');
      const config = getConfig();

      const result = await finalizeReport(
        currentListingAddress,
        pendingReportData,
        overrides,
        descEdits,
        config
      );

      pendingReportData = null;
      return result;
    } catch (err) {
      throw new Error(friendlyError(err));
    }
  });

  ipcMain.handle('review:back', () => {
    pendingReportData = null;
    mainWindow.loadFile(
      path.join(__dirname, '..', 'renderer', 'dashboard.html')
    );
    return { ok: true };
  });

  ipcMain.handle('email:show', (_event, emailData) => {
    mainWindow.loadFile(
      path.join(__dirname, '..', 'renderer', 'dashboard.html')
    );
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('email:ready', emailData);
    });
    return { ok: true };
  });

  ipcMain.handle('email:copy', (_event, data) => {
    if (data.html) {
      clipboard.write({
        text: data.text || '',
        html: data.html,
      });
    } else {
      clipboard.writeText(data.text || data);
    }
    return { ok: true };
  });

  ipcMain.handle('shell:openPath', (_event, filePath) => {
    // Security: restrict to app's own data directory and block executables
    const allowedBase = path.join(app.getPath('userData'), 'market-report');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(allowedBase + path.sep) && resolved !== allowedBase) {
      throw new Error('Path not allowed — can only open files within the app data directory.');
    }
    const dangerousExts = ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.msi', '.com', '.scr'];
    const ext = path.extname(resolved).toLowerCase();
    if (dangerousExts.includes(ext)) {
      throw new Error('Cannot open executable files.');
    }
    shell.openPath(resolved);
    return { ok: true };
  });

  ipcMain.handle('report:history', async () => {
    const { getDb } = await import('../db/schema.js');
    const db = getDb();
    const rows = db
      .prepare('SELECT id, listing_address, run_date, email_body FROM reports ORDER BY run_date DESC LIMIT 20')
      .all();
    return rows;
  });
}
