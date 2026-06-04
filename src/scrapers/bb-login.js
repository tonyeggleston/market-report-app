import { launchBrowser, delay, validateLogin } from './browser-helpers.js';

export async function launchBrokerBayBrowser(config) {
  return launchBrowser(config);
}

export async function loginToBrokerBay(page, config, onProgress) {
  onProgress('Logging into BrokerBay...', 'Navigating');
  await page.goto(config.brokerBayUrl, { waitUntil: 'networkidle', timeout: 45000 });

  // BrokerBay Edge uses Supra One (auth.brokerbay.com) — two-step login:
  // Step 1: Enter email → click Continue
  // Step 2: Enter password → click Continue

  // Step 1: Email
  onProgress('Logging into BrokerBay...', 'Entering email');
  await page.waitForSelector(
    'input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="username"]',
    { timeout: 20000 }
  );

  const emailField = await page.$(
    'input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="username"]'
  );

  if (!emailField) {
    throw new Error('Could not find BrokerBay email field.');
  }

  await emailField.fill(config.brokerBayUsername);
  await delay(500);

  // Click Continue / Submit for email step
  const continueBtn = await page.$(
    'button[type="submit"], button:has-text("Continue"), button:has-text("Next"), button:has-text("Log In"), button:has-text("Sign In")'
  );
  if (continueBtn) {
    await continueBtn.click();
  } else {
    await emailField.press('Enter');
  }

  // Step 2: Wait for password field to appear (may be on same page or new page)
  onProgress('Logging into BrokerBay...', 'Entering password');
  try {
    await page.waitForSelector(
      'input[type="password"]',
      { timeout: 15000 }
    );
  } catch {
    // If no password field appears, the login might be single-step or SSO
    // Check if we're already logged in
    const url = page.url();
    if (url.includes('brokerbay.com') && !url.includes('auth.')) {
      onProgress('Logging into BrokerBay...', 'Logged in (SSO)');
      return page;
    }
    throw new Error('Password field did not appear after entering email. The login flow may have changed.');
  }

  const passField = await page.$('input[type="password"]');
  if (!passField) {
    throw new Error('Could not find BrokerBay password field.');
  }

  await passField.fill(config.brokerBayPassword);
  await delay(500);

  // Click Continue / Submit for password step
  const submitBtn = await page.$(
    'button[type="submit"], button:has-text("Continue"), button:has-text("Log In"), button:has-text("Sign In")'
  );
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passField.press('Enter');
  }

  // Wait for redirect back to BrokerBay
  onProgress('Logging into BrokerBay...', 'Waiting for redirect');
  try {
    await page.waitForURL('**/edge.brokerbay.com/**', { timeout: 30000 });
  } catch {
    // Fallback: wait for navigation
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
    } catch { /* may already be there */ }
  }

  const loginFailed = await validateLogin(page);
  if (loginFailed) {
    throw new Error(`BrokerBay login failed: ${loginFailed}`);
  }

  onProgress('Logging into BrokerBay...', 'Logged in');
  return page;
}
