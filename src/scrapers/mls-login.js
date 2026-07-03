import { launchBrowser, delay, validateLogin } from './browser-helpers.js';
import { sel } from './selectors.js';
import { capturePage } from './capture.js';

export async function launchMlsBrowser(config) {
  return launchBrowser(config);
}

export async function loginToMls(page, config, onProgress) {
  onProgress('Logging into MLS...', 'Navigating to Matrix');
  await page.goto(config.mlsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await capturePage(page, 'mls-login-page');

  const userSel = sel('mls.login.username', 'input[name="username"], input[id="username"], input[name="user"], #user');
  const passSel = sel('mls.login.password', 'input[name="password"], input[id="password"], input[name="pass"], #pass');

  await page.waitForSelector(userSel, { timeout: 15000 });

  const userField = await page.$(userSel);
  const passField = await page.$(passSel);

  if (!userField || !passField) {
    throw new Error('Could not find MLS login fields. The login page may have changed.');
  }

  await userField.fill(config.mlsUsername);
  await delay(300);
  await passField.fill(config.mlsPassword);
  await delay(300);

  const submitBtn = await page.$(
    sel('mls.login.submit', 'button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")')
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
  await capturePage(page, 'ntreis-dashboard-portal');

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

  // The dashboard tile structure (Clareity/Angular):
  //   <app-standard-app><div class="appborder">
  //     <div class="app-icon" isformpost="false" id="386"><img ...></div>
  //     <div class="app-title-container" id="appDetailmatrix"><h4 class="apptitle">Matrix</h4></div>
  //   </div></app-standard-app>
  // The CLICK HANDLER is on the .app-icon (id 386 for Matrix), not the title.
  // Launching opens Matrix in a new tab (or sometimes same tab).
  const defaultTargets = [
    '#386',                                                        // Matrix app-icon (Clareity app id)
    'app-standard-app:has(h4.apptitle:text-is("Matrix")) .app-icon',
    'app-standard-app:has(h4.apptitle:text-is("Matrix")) img',
    '.app-icon:right-of(:text-is("Matrix"))',
    '#appDetailmatrix',
  ];
  // Override via config with a '|||'-separated list of selectors to try in order.
  const targetOverride = sel('mls.portal.matrixTargets', '');
  const clickTargets = targetOverride
    ? targetOverride.split('|||').map((s) => s.trim()).filter(Boolean)
    : defaultTargets;

  let clicked = false;
  for (const target of clickTargets) {
    try {
      const el = await page.waitForSelector(target, { timeout: 6000 });
      if (!el) continue;

      // Click and watch for a new tab opening at the same time.
      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 12000 }).catch(() => null),
        el.click({ timeout: 5000 }).catch(() => {}),
      ]);

      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await popup.waitForTimeout(3000);
        onProgress('Logging into MLS...', 'Matrix opened in new tab');
        return popup;
      }

      // No popup — check if THIS tab navigated into Matrix.
      await page.waitForTimeout(2500);
      if (/matrix/i.test(page.url()) && !/dashboard/i.test(page.url())) {
        onProgress('Logging into MLS...', 'Matrix opened');
        return page;
      }

      clicked = true;
      // Click landed but no launch detected yet — try the next target.
    } catch { /* try next selector */ }
  }

  // Last resort: scan all open tabs — Matrix may have opened without firing
  // the event we caught.
  const pages = page.context().pages();
  for (const p of pages) {
    if (/matrix/i.test(p.url()) && !/dashboard/i.test(p.url())) {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      onProgress('Logging into MLS...', 'Matrix tab found');
      return p;
    }
  }

  onProgress('Logging into MLS...',
    clicked ? 'Clicked Matrix tile but launch not detected — continuing' : 'Matrix tile not found — continuing');
  return page;
}
