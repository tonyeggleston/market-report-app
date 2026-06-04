import { app, BrowserWindow, ipcMain, shell, clipboard, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, isSetupComplete } from './config.js';
import { initDb } from '../db/schema.js';
import { validateLicense, canRunReport, reportCompleted, activateLicense, getLicenseKey, saveLicenseKey } from './license.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let pendingReportData = null;
let currentListingAddress = null;
const DEMO_MODE = process.argv.includes('--demo');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'MarketPulse',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const setupDone = DEMO_MODE || isSetupComplete();
  const page = setupDone ? 'dashboard.html' : 'setup.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', page));
}

function migrateConfig() {
  try {
    const config = getConfig();
    if (!config) return;

    let changed = false;

    // Fix BrokerBay URL if it's the old default
    if (!config.brokerBayUrl || config.brokerBayUrl === 'https://app.brokerbay.com') {
      config.brokerBayUrl = 'https://edge.brokerbay.com';
      changed = true;
    }

    // Fix BrokerBay username — needs to be an email for Supra One login
    if (config.brokerBayUsername && !config.brokerBayUsername.includes('@')) {
      // Old config had a username, not an email — clear it so Settings prompts
      config.brokerBayUsername = '';
      changed = true;
    }

    // Ensure defaults exist
    if (!config.teamBrokerage) { config.teamBrokerage = 'The Davis Team'; changed = true; }
    if (!config.agentName) { config.agentName = 'Bryan'; changed = true; }
    if (!config.reportPeriod) { config.reportPeriod = 'two months'; changed = true; }
    if (!config.openrouterModel) { config.openrouterModel = 'google/gemini-2.5-flash'; changed = true; }

    if (changed) saveConfig(config);
  } catch { /* first run, no config yet */ }
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
  migrateConfig();
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
    if (DEMO_MODE) return getDemoConfig();
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

  // ─── License IPC handlers ───

  ipcMain.handle('license:validate', async () => {
    if (DEMO_MODE) return { active: true, plan: 'demo', reportsIncluded: 999, reportsUsed: 0, overageRate: 0 };
    return validateLicense();
  });

  ipcMain.handle('license:canRun', async () => {
    if (DEMO_MODE) return { allowed: true, reportsUsed: 0, reportsIncluded: 999, message: 'Demo mode' };
    return canRunReport();
  });

  ipcMain.handle('license:activate', async (_event, licenseKey) => {
    return activateLicense(licenseKey);
  });

  ipcMain.handle('license:getKey', () => {
    if (DEMO_MODE) return 'DEMO-MODE';
    return getLicenseKey();
  });

  ipcMain.handle('license:saveKey', (_event, key) => {
    saveLicenseKey(key);
    return { ok: true };
  });

  // ─── Report runner (with license gating) ───

  ipcMain.handle('report:run', async (_event, listingAddress) => {
    if (DEMO_MODE) return runDemoReport(listingAddress);

    // Check license before running
    const check = await canRunReport();
    if (!check.allowed) {
      throw new Error(check.message);
    }

    try {
      const { runReport } = await import('../scrapers/orchestrator.js');

      currentListingAddress = listingAddress;

      const result = await runReport(listingAddress, (step, detail) => {
        mainWindow.webContents.send('report:progress', { step, detail });
      });

      if (result.needsReview) {
        pendingReportData = result.reportData;
        return { needsReview: true, licenseCheck: check };
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
    if (DEMO_MODE) return finalizeDemoReport(overrides, descEdits);

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

      // Report finalized — notify license server to increment usage + bill overage
      reportCompleted(currentListingAddress).catch(() => {});

      pendingReportData = null;
      return result;
    } catch (err) {
      throw new Error(friendlyError(err));
    }
  });

  ipcMain.handle('report:openFolder', () => {
    const runsDir = path.join(app.getPath('userData'), 'market-report', 'runs');
    try { fs.mkdirSync(runsDir, { recursive: true }); } catch { /* ok */ }
    shell.openPath(runsDir);
    return { ok: true };
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
    if (DEMO_MODE) return [];
    const { getDb } = await import('../db/schema.js');
    const db = getDb();
    const rows = db
      .prepare('SELECT id, listing_address, run_date, email_body FROM reports ORDER BY run_date DESC LIMIT 20')
      .all();
    return rows;
  });
}

// ═══════════════════════════════════════════════════════════
// Demo mode — fake data for UI testing
// ═══════════════════════════════════════════════════════════

function getDemoConfig() {
  return {
    mlsUsername: 'leah.rail',
    mlsUrl: 'https://matrix.ntreis.net',
    brokerBayUsername: 'leah@thedavisteam.com',
    brokerBayUrl: 'https://app.brokerbay.com',
    teamBrokerage: 'The Davis Team',
    teamMembers: ['Leah Rail', 'Jordan Davis', 'Rebecca Chen'],
    agentName: 'Jordan',
    reportPeriod: 'two months',
    emailTemplate: '',
    openrouterModel: 'google/gemini-2.5-flash',
  };
}

function demoDelay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runDemoReport(listingAddress) {
  currentListingAddress = listingAddress || '1425 Hillcrest';
  const send = (step, detail) => mainWindow.webContents.send('report:progress', { step, detail });

  send('Logging into MLS...', 'Navigating to Matrix');
  await demoDelay(600);
  send('Logging into MLS...', 'Logged in');
  await demoDelay(400);
  send('Running saved search...', 'Searching for ' + currentListingAddress);
  await demoDelay(800);
  send('Running saved search...', '12 results found');
  await demoDelay(400);
  send('Downloading photos...', '12 listings to photograph');
  await demoDelay(500);
  send('Downloading photos...', 'MLS-2024-1001: 24 photos found');
  await demoDelay(300);
  send('Downloading photos...', 'MLS-2024-1002: 18 photos found');
  await demoDelay(300);
  send('Extracting listing details...', 'Reading descriptions');
  await demoDelay(600);
  send('Analyzing subject property...', 'Building style profile from 24 photos');
  await demoDelay(700);
  send('Analyzing comp photos...', '12 listings to analyze');
  await demoDelay(500);
  send('Analyzing comp photos...', '6 of 12 complete');
  await demoDelay(500);
  send('Analyzing comp photos...', '12 of 12 complete');
  await demoDelay(300);
  send('Running price-only search...', '$425,000 – $625,000 range');
  await demoDelay(500);
  send('Logging into BrokerBay...', 'Navigating');
  await demoDelay(500);
  send('Logging into BrokerBay...', 'Logged in');
  await demoDelay(400);
  send('Pulling showings...', 'Last 2 weeks');
  await demoDelay(600);
  send('Pulling showings...', '7 confirmed showings');
  await demoDelay(300);
  send('Pulling market trends...', 'Price range: $425,000 – $625,000');
  await demoDelay(600);
  send('Comparing to previous report...', '3 new, 2 status changes');
  await demoDelay(400);
  send('Calculating metrics...', 'Showings per listing, DOM stats');
  await demoDelay(300);
  send('Generating descriptions...', 'Writing listing narratives');
  await demoDelay(700);
  send('Done!', 'Ready for review');

  pendingReportData = buildDemoReportData(currentListingAddress);
  return { needsReview: true };
}

function buildDemoReportData(listingAddress) {
  const comps = [
    { mlsNumber: 'MLS-2024-1001', address: listingAddress, sqft: 2450, yearBuilt: 2005, lotAcres: 0.18, hasPool: true, price: 525000, status: 'Active', dom: 14, flag: '', description: 'Beautifully updated home with modern finishes throughout.' },
    { mlsNumber: 'MLS-2024-1002', address: '1510 Oak Ridge Dr', sqft: 2380, yearBuilt: 2003, lotAcres: 0.21, hasPool: false, price: 489000, status: 'Active', dom: 22, flag: 'N', description: 'Well-maintained with original kitchen and updated bathrooms.' },
    { mlsNumber: 'MLS-2024-1003', address: '830 Timber Creek Ln', sqft: 2620, yearBuilt: 2007, lotAcres: 0.24, hasPool: true, price: 559000, status: 'Active', dom: 8, flag: 'N', description: 'Fully remodeled with chef kitchen, quartz counters, and covered patio.' },
    { mlsNumber: 'MLS-2024-1004', address: '2205 Pecan Valley Ct', sqft: 2150, yearBuilt: 2001, lotAcres: 0.16, hasPool: false, price: 465000, status: 'Active', dom: 35, flag: '', description: 'Dated flooring and bathrooms. New roof 2023. Large backyard.' },
    { mlsNumber: 'MLS-2024-1005', address: '975 Sunridge Blvd', sqft: 2510, yearBuilt: 2006, lotAcres: 0.19, hasPool: true, price: 545000, status: 'Option Pending', dom: 18, flag: '', previousStatus: 'Active', description: 'Modern whites and grays throughout, plantation shutters, pool.' },
    { mlsNumber: 'MLS-2024-1006', address: '1680 Meadow Bend Dr', sqft: 2700, yearBuilt: 2008, lotAcres: 0.28, hasPool: true, price: 589000, status: 'Contingent', dom: 12, flag: '', previousStatus: 'Active', description: 'Premium lot with mature trees. Updated kitchen, original baths.' },
    { mlsNumber: 'MLS-2024-1007', address: '420 Creekside Way', sqft: 2300, yearBuilt: 2004, lotAcres: 0.17, hasPool: false, price: 479000, status: 'Active', dom: 41, flag: '', description: 'Earth tone palette, carpet throughout. Seashell sinks in master bath.' },
    { mlsNumber: 'MLS-2024-1008', address: '3100 Preston Oaks', sqft: 2480, yearBuilt: 2006, lotAcres: 0.20, hasPool: false, price: 499000, status: 'Active', dom: 5, flag: 'N', description: 'New to market — semi-updated with wood look laminate, white cabinets.' },
  ];

  const ourListing = comps[0];

  const visionResults = {};
  const analysisTemplates = [
    {
      matchScore: 7, includeRecommendation: true, overallUpdateLevel: 'semi-updated', reasoning: 'Kitchen has been updated with stainless appliances but original oak cabinets remain. Bathrooms are dated with builder-grade fixtures. Flooring is a mix of carpet and tile — not consistent with subject.',
      redFlags: [],
      analysis: { kitchen: { update_level: 'semi-updated', white_cabinets: false, stainless_appliances: true }, bathrooms: [{ update_level: 'dated', palette: 'beige/tan', standalone_tub: false }], flooring: { type: 'mixed', consistent: false }, palette: { modern_whites_grays: false, dominant_colors: ['beige', 'tan', 'brown'] }, outdoor: { covered_patio: true, pool: false, backyard_size: 'medium' } },
    },
    {
      matchScore: 9, includeRecommendation: true, overallUpdateLevel: 'fully updated', reasoning: 'Excellent match to subject. White cabinets, quartz countertops, wood look laminate throughout, modern gray palette. Covered patio with pool is comparable. Only difference is slightly larger lot.',
      redFlags: [],
      analysis: { kitchen: { update_level: 'modern', white_cabinets: true, stainless_appliances: true }, bathrooms: [{ update_level: 'modern', palette: 'white/gray', standalone_tub: true }, { update_level: 'modern', palette: 'white/gray', standalone_tub: false }], flooring: { type: 'wood_look_laminate', consistent: true }, palette: { modern_whites_grays: true, dominant_colors: ['white', 'gray'] }, outdoor: { covered_patio: true, pool: true, backyard_size: 'large' } },
    },
    {
      matchScore: 4, includeRecommendation: false, overallUpdateLevel: 'dated', reasoning: 'Significantly dated throughout — carpet in living areas, original 2001 kitchen with oak cabinets and laminate counters. Bathroom has seashell-shaped sinks. Color palette is earth tones. New roof is a plus but visual package does not match subject.',
      redFlags: ['seashell sinks', 'earth tone palette', 'carpet throughout', 'oak cabinets'],
      analysis: { kitchen: { update_level: 'dated', white_cabinets: false, stainless_appliances: false }, bathrooms: [{ update_level: 'dated', palette: 'tan/brown', standalone_tub: false }], flooring: { type: 'carpet', consistent: true }, palette: { modern_whites_grays: false, dominant_colors: ['tan', 'brown', 'forest green'] }, outdoor: { covered_patio: false, pool: false, backyard_size: 'large' } },
    },
    {
      matchScore: 8, includeRecommendation: true, overallUpdateLevel: 'mostly updated', reasoning: 'Strong visual match — whites and grays, plantation shutters, updated kitchen. Pool and covered patio match subject. Only slight miss is master bath still has original tile surround.',
      redFlags: [],
      analysis: { kitchen: { update_level: 'modern', white_cabinets: true, stainless_appliances: true }, bathrooms: [{ update_level: 'semi-updated', palette: 'white/beige', standalone_tub: true }], flooring: { type: 'wood_look_laminate', consistent: true }, palette: { modern_whites_grays: true, dominant_colors: ['white', 'light gray'] }, outdoor: { covered_patio: true, pool: true, backyard_size: 'medium' } },
    },
    {
      matchScore: 6, includeRecommendation: true, overallUpdateLevel: 'semi-updated', reasoning: 'Updated kitchen with white cabinets but original bathroom. Larger premium lot with mature trees is a differentiator. Pool area is nicely done.',
      redFlags: ['original bathrooms'],
      analysis: { kitchen: { update_level: 'modern', white_cabinets: true, stainless_appliances: true }, bathrooms: [{ update_level: 'dated', palette: 'beige', standalone_tub: false }], flooring: { type: 'hardwood', consistent: false }, palette: { modern_whites_grays: false, dominant_colors: ['white', 'beige', 'wood'] }, outdoor: { covered_patio: true, pool: true, backyard_size: 'large' } },
    },
    {
      matchScore: 3, includeRecommendation: false, overallUpdateLevel: 'dated', reasoning: 'Earth tones throughout, carpet in all living areas, dated fixtures. Seashell sinks are a red flag — clearly not a visual match for the subject property.',
      redFlags: ['seashell sinks', 'earth tone palette', 'dated fixtures', 'swinging farm doors'],
      analysis: { kitchen: { update_level: 'dated', white_cabinets: false, stainless_appliances: false }, bathrooms: [{ update_level: 'dated', palette: 'tan', standalone_tub: false }], flooring: { type: 'carpet', consistent: true }, palette: { modern_whites_grays: false, dominant_colors: ['tan', 'brown', 'burgundy'] }, outdoor: { covered_patio: false, pool: false, backyard_size: 'small' } },
    },
    {
      matchScore: 7, includeRecommendation: true, overallUpdateLevel: 'semi-updated', reasoning: 'New to market. Wood look laminate and white cabinets are on trend. Bathrooms appear semi-updated. No pool but comparable square footage and year built.',
      redFlags: [],
      analysis: { kitchen: { update_level: 'semi-updated', white_cabinets: true, stainless_appliances: true }, bathrooms: [{ update_level: 'semi-updated', palette: 'gray/white', standalone_tub: false }], flooring: { type: 'wood_look_laminate', consistent: true }, palette: { modern_whites_grays: true, dominant_colors: ['white', 'gray'] }, outdoor: { covered_patio: false, pool: false, backyard_size: 'medium' } },
    },
  ];

  for (let i = 1; i < comps.length; i++) {
    const tmpl = analysisTemplates[(i - 1) % analysisTemplates.length];
    visionResults[comps[i].mlsNumber] = {
      matchScore: tmpl.matchScore,
      includeRecommendation: tmpl.includeRecommendation,
      overallUpdateLevel: tmpl.overallUpdateLevel,
      reasoning: tmpl.reasoning,
      redFlags: tmpl.redFlags,
      photoCount: 12 + i * 2,
      analysis: tmpl.analysis,
    };
  }

  const compDescriptions = {
    'MLS-2024-1002': 'This home is well-maintained with an updated kitchen featuring stainless appliances, though the oak cabinets and mixed flooring differ from our subject. It does have a covered patio.',
    'MLS-2024-1003': 'An excellent comparable — fully remodeled with white cabinets, quartz counters, and wood look laminate throughout. The covered patio and pool are comparable to ours. Listed higher at $559,000.',
    'MLS-2024-1008': 'New to market this week. Semi-updated with white cabinets and wood look laminate, similar palette to our subject. No pool, priced at $499,000.',
  };

  const statusNarratives = {
    'MLS-2024-1005': '975 Sunridge Blvd went under contract after 18 days on market at its listing price of $545,000. This is a strong comp — modern whites and grays throughout with a pool, very similar visual package to ours.',
    'MLS-2024-1006': '1680 Meadow Bend Dr went contingent after just 12 days on market. Listed at $589,000 on a premium 0.28-acre lot. Kitchen was updated but bathrooms were original.',
  };

  const diff = {
    newListings: comps.filter(c => c.flag === 'N'),
    statusChanges: comps.filter(c => c.previousStatus),
    priceChanges: [],
    summary: { newCount: 3, statusChangeCount: 2, priceChangeCount: 0 },
  };

  const metrics = {
    showingCount: 7,
    showingsPerListing: '4.2',
    ourDom: 14,
    avgDomActive: 21,
    maxDomActive: 41,
    minDomActive: 5,
    activeCount: 6,
    priceRange: { min: 465000, max: 589000 },
  };

  return {
    comps,
    ourListing,
    subjectProfile: { palette: 'whites and grays', flooringType: 'wood look laminate', kitchenStyle: 'modern white cabinets', bathroomStyle: 'modern standalone tub', updateLevel: 'fully updated' },
    visionResults,
    compDescriptions,
    statusNarratives,
    diff,
    metrics,
    showingData: {
      recentShowings: [
        { date: '2024-06-01', time: '10:00 AM', agentName: 'Sarah Mitchell', brokerage: 'Coldwell Banker', status: 'confirmed' },
        { date: '2024-06-02', time: '2:30 PM', agentName: 'Mark Thompson', brokerage: 'RE/MAX Elite', status: 'confirmed' },
        { date: '2024-06-03', time: '11:00 AM', agentName: 'Lisa Nguyen', brokerage: 'Keller Williams', status: 'confirmed' },
        { date: '2024-06-05', time: '3:00 PM', agentName: 'David Rodriguez', brokerage: 'Compass', status: 'confirmed' },
        { date: '2024-06-07', time: '1:00 PM', agentName: 'Amy Chen', brokerage: 'Century 21', status: 'confirmed' },
        { date: '2024-06-09', time: '10:30 AM', agentName: 'James Wilson', brokerage: 'Ebby Halliday', status: 'confirmed' },
        { date: '2024-06-12', time: '4:00 PM', agentName: 'Karen Brown', brokerage: 'Briggs Freeman', status: 'confirmed' },
      ],
      teamShowings: [
        { date: '2024-06-08', time: '12:00 PM', agentName: 'Leah Rail', brokerage: 'The Davis Team', status: 'confirmed' },
      ],
      totalShowingsSinceLive: 23,
      feedback: [
        { agent: 'Sarah Mitchell', brokerage: 'Coldwell Banker', rating: '4/5', comments: 'Beautiful home, very well staged. Buyers loved the kitchen and pool. Price feels right for the area.', offerIntent: 'Buyers are discussing with lender' },
        { agent: 'Mark Thompson', brokerage: 'RE/MAX Elite', rating: '5/5', comments: 'Gorgeous updates throughout. Best home we\'ve seen in this price range. Clients are very interested.', offerIntent: 'Expecting to submit an offer this week' },
        { agent: 'Lisa Nguyen', brokerage: 'Keller Williams', rating: '3/5', comments: 'Nice home but clients wanted a larger backyard. Pool is a plus but lot feels small.', offerIntent: 'No offer — continuing to look' },
      ],
    },
    trendData: { totalAreaShowings: 42 },
    priceSearchResult: { activeCount: 10 },
    closedStats: { avgDomClosed: 28, avgSoldPrice: 512000 },
    listDate: 'May 21, 2024',
    totalShowings: 23,
    photosByMls: Object.fromEntries(comps.map(c => [c.mlsNumber, { photoCount: 16, photoDir: null }])),
  };
}

function finalizeDemoReport(overrides, descEdits) {
  const data = pendingReportData;
  if (!data) return { emailBody: 'Demo report', emailHtml: '<p>Demo report generated.</p>' };

  const html = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 14px; color: #1a1a1a; line-height: 1.6; max-width: 700px;">
<p>We saw <strong>${data.metrics.showingCount}</strong> showings over the past two months versus the market saw <strong>${data.metrics.showingsPerListing}</strong> showings per listing in your area.</p>
<p>You have seen a total of <strong>${data.totalShowings}</strong> showings since going live on ${data.listDate}.</p>
<p>We have been on the market for <strong>${data.metrics.ourDom}</strong> days. The average days on market for active listings is ${data.metrics.avgDomActive} with ${data.metrics.maxDomActive} being the most and ${data.metrics.minDomActive} being the least.</p>
<p><strong>${data.diff.summary.newCount} new listings have come to the market:</strong></p>
${data.diff.newListings.map(l => `<div style="margin: 16px 0; padding: 16px; background: #f9fafb; border-radius: 8px; border-left: 4px solid #2563eb;"><p style="margin: 0 0 8px;"><strong>${l.address}</strong> — ${l.sqft} sq ft, built ${l.yearBuilt}, ${l.lotAcres} acres${l.hasPool ? ', pool' : ', no pool'}. Listed for <strong>$${l.price.toLocaleString()}</strong>.</p><p style="margin: 0; color: #374151;">${descEdits?.[l.mlsNumber] || data.compDescriptions[l.mlsNumber] || l.description}</p></div>`).join('')}
<p><strong>${data.diff.summary.statusChangeCount} homes have gone under contract since our last report:</strong></p>
${data.diff.statusChanges.map(l => `<div style="margin: 16px 0; padding: 16px; background: #f9fafb; border-radius: 8px; border-left: 4px solid #f59e0b;"><p style="margin: 0;">${data.statusNarratives[l.mlsNumber] || l.description}</p></div>`).join('')}
<p><strong>Showing feedback received:</strong></p>
<ul>${data.showingData.feedback.map(fb => `<li><strong>${fb.agent}</strong> (${fb.brokerage}) — rated ${fb.rating} — "${fb.comments}" ${fb.offerIntent}</li>`).join('')}</ul>
<p>The average days on market for closed homes within the last 90 days is <strong>${data.closedStats.avgDomClosed}</strong> with an average sales price of <strong>$${data.closedStats.avgSoldPrice.toLocaleString()}</strong>.</p>
<p>Jordan will reach out to you to discuss this if she hasn't already. Please let us know if you need anything.</p>
</div>`;

  pendingReportData = null;
  return { emailBody: 'Demo plain text version', emailHtml: html };
}
