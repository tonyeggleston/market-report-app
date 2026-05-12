import { chromium } from 'playwright';
import { getLaunchOptions } from './browser-path.js';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchBrowser(config) {
  const browser = await chromium.launch(getLaunchOptions());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * After login navigation, check whether the login actually succeeded.
 * Returns null on success or an error string on failure.
 */
export async function validateLogin(page) {
  return page.evaluate(() => {
    const errorEl = document.querySelector(
      '[class*="error"], [class*="Error"], .alert-danger, [class*="invalid"], [role="alert"]'
    );
    if (errorEl && errorEl.textContent.trim()) return errorEl.textContent.trim();
    const passField = document.querySelector('input[type="password"]');
    if (passField && passField.offsetParent !== null) return 'Login page still visible — credentials may be wrong.';
    return null;
  });
}
