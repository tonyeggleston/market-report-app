import { launchBrowser, delay, validateLogin } from './browser-helpers.js';

export async function launchMlsBrowser(config) {
  return launchBrowser(config);
}

export async function loginToMls(page, config, onProgress) {
  onProgress('Logging into MLS...', 'Navigating to Matrix');
  await page.goto(config.mlsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  await page.waitForSelector(
    'input[name="username"], input[id="username"], input[name="user"], #user',
    { timeout: 15000 }
  );

  const userField = await page.$(
    'input[name="username"], input[id="username"], input[name="user"], #user'
  );
  const passField = await page.$(
    'input[name="password"], input[id="password"], input[name="pass"], #pass'
  );

  if (!userField || !passField) {
    throw new Error('Could not find MLS login fields. The login page may have changed.');
  }

  await userField.fill(config.mlsUsername);
  await delay(300);
  await passField.fill(config.mlsPassword);
  await delay(300);

  const submitBtn = await page.$(
    'button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")'
  );
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passField.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const loginFailed = await validateLogin(page);
  if (loginFailed) {
    throw new Error(`MLS login failed: ${loginFailed}`);
  }

  onProgress('Logging into MLS...', 'Logged in');

  // After NTREIS login we land on the MetroTex/NTREIS Dashboard portal,
  // not Matrix itself. We must click the "Matrix" app tile to launch it.
  // Matrix opens in a new browser tab.
  const matrixPage = await launchMatrixApp(page, onProgress);
  return matrixPage || page;
}

async function launchMatrixApp(page, onProgress) {
  // If we're already in Matrix (URL contains matrix), nothing to do.
  const url = page.url();
  if (url.includes('matrix') && !url.includes('clareity') && !url.includes('dashboard')) {
    return page;
  }

  onProgress('Logging into MLS...', 'Launching Matrix');

  // Wait for the dashboard's Matrix tile to appear.
  // Structure: <div class="app-title-container" id="appDetailmatrix"><h4 class="apptitle">Matrix</h4></div>
  // with a sibling .app-icon. The whole tile is clickable and opens a new tab.
  const tileSelectors = [
    '#appDetailmatrix',
    'app-standard-app:has-text("Matrix")',
    '.app-item:has-text("Matrix")',
    '.app-icon:near(#appDetailmatrix)',
    'h4.apptitle:has-text("Matrix")',
  ];

  let tile = null;
  for (const sel of tileSelectors) {
    try {
      tile = await page.waitForSelector(sel, { timeout: 8000 });
      if (tile) break;
    } catch { /* try next selector */ }
  }

  if (!tile) {
    // Maybe SSO landed us straight in Matrix already, or the portal changed.
    onProgress('Logging into MLS...', 'Matrix tile not found — continuing on current page');
    return page;
  }

  // Clicking the tile opens Matrix in a new tab. Capture it.
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null),
    tile.click().catch(() => {}),
  ]);

  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForTimeout(2000);
    onProgress('Logging into MLS...', 'Matrix opened');
    return popup;
  }

  // No popup — maybe it navigated in the same tab.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  return page;
}
