import { launchBrowser, delay, validateLogin } from './browser-helpers.js';

export async function launchBrokerBayBrowser(config) {
  return launchBrowser(config);
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

  const loginFailed = await validateLogin(page);
  if (loginFailed) {
    throw new Error(`BrokerBay login failed: ${loginFailed}`);
  }

  onProgress('Logging into BrokerBay...', 'Logged in');
  return page;
}
