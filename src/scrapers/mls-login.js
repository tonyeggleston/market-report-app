import { chromium } from 'playwright';
import { getLaunchOptions } from './browser-path.js';

export async function launchMlsBrowser(config) {
  const browser = await chromium.launch(getLaunchOptions());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function loginToMls(page, config, onProgress) {
  onProgress('Logging into MLS...', 'Navigating to Matrix');
  await page.goto(config.mlsUrl, { waitUntil: 'networkidle', timeout: 45000 });

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

  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
  onProgress('Logging into MLS...', 'Logged in');
  return page;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
