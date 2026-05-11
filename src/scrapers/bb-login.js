import { chromium } from 'playwright';
import { getLaunchOptions } from './browser-path.js';

export async function launchBrokerBayBrowser(config) {
  const browser = await chromium.launch(getLaunchOptions());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function loginToBrokerBay(page, config, onProgress) {
  onProgress('Logging into BrokerBay...', 'Navigating');
  await page.goto(config.brokerBayUrl, { waitUntil: 'networkidle', timeout: 45000 });

  await page.waitForSelector(
    'input[name="email"], input[type="email"], input[id="email"], input[name="username"]',
    { timeout: 15000 }
  );

  const emailField = await page.$(
    'input[name="email"], input[type="email"], input[id="email"], input[name="username"]'
  );
  const passField = await page.$(
    'input[name="password"], input[type="password"]'
  );

  if (!emailField || !passField) {
    throw new Error('Could not find BrokerBay login fields.');
  }

  await emailField.fill(config.brokerBayUsername);
  await delay(300);
  await passField.fill(config.brokerBayPassword);
  await delay(300);

  const submitBtn = await page.$(
    'button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In")'
  );
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passField.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
  onProgress('Logging into BrokerBay...', 'Logged in');
  return page;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
