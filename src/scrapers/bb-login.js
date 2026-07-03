import { launchBrowser, delay, validateLogin } from './browser-helpers.js';
import { sel } from './selectors.js';
import { capturePage } from './capture.js';

export async function launchBrokerBayBrowser(config) {
  return launchBrowser(config);
}

export async function loginToBrokerBay(page, config, onProgress) {
  if (!config.brokerBayUsername || !config.brokerBayUsername.includes('@')) {
    throw new Error('BrokerBay email not set. Go to Settings and enter your BrokerBay email address.');
  }

  onProgress('Logging into BrokerBay...', 'Navigating');
  await page.goto(config.brokerBayUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await capturePage(page, 'bb-supra-email');

  // BrokerBay Edge login flow (Supra One → NTREIS SSO):
  // 1. Enter email → Continue
  // 2. Click "Log in with NTREIS"
  // 3. Enter MLS username + password on NTREIS page
  // 4. Wait for redirect back to BrokerBay

  // Step 1: Enter email on Supra One
  onProgress('Logging into BrokerBay...', 'Entering email');
  const bbEmailSel = sel('bb.login.email', 'input[type="email"], input[placeholder*="Email"]');
  await page.waitForSelector(bbEmailSel, { timeout: 20000 });

  const emailField = await page.$(bbEmailSel);
  if (!emailField) throw new Error('Could not find BrokerBay email field.');

  await emailField.fill(config.brokerBayUsername);
  await delay(500);

  // Click Continue
  const continueBtn = await page.$(
    sel('bb.login.continue', 'button[type="submit"], button:has-text("Continue")')
  );
  if (continueBtn) {
    await continueBtn.click();
  } else {
    await emailField.press('Enter');
  }

  // Step 2: Wait for IdP choice screen, click "Log in with NTREIS"
  onProgress('Logging into BrokerBay...', 'Selecting NTREIS login');
  await delay(2000);
  await capturePage(page, 'bb-idp-choice');

  // Look for the NTREIS button — it might say "Log in with NTREIS" or similar
  const ntreidBtn = await page.$(
    sel('bb.login.ntreisButton', 'button:has-text("NTREIS"), a:has-text("NTREIS"), button:has-text("Log in with NTREIS")')
  );

  if (ntreidBtn) {
    await ntreidBtn.click();
    await delay(2000);
  } else {
    // Maybe it went straight to password — check for password field
    const directPass = await page.$('input[type="password"]');
    if (!directPass) {
      // Check if there's a Honeywell button we should skip past
      const honeywellBtn = await page.$('button:has-text("Honeywell")');
      if (honeywellBtn) {
        // Look harder for NTREIS
        const allButtons = await page.$$('button');
        for (const btn of allButtons) {
          const text = await btn.textContent();
          if (text.includes('NTREIS')) {
            await btn.click();
            await delay(2000);
            break;
          }
        }
      }
    }
  }

  // Step 3: NTREIS login page — enter MLS credentials
  onProgress('Logging into BrokerBay...', 'Entering MLS credentials');
  await capturePage(page, 'bb-ntreis-login');
  try {
    await page.waitForSelector(
      sel('bb.login.ntreisUsername', 'input[placeholder="Username"], input[name="username"], input[type="text"]'),
      { timeout: 15000 }
    );
  } catch {
    // May already be past login if SSO session exists
    const url = page.url();
    if (url.includes('brokerbay.com') && !url.includes('auth.') && !url.includes('clareity')) {
      onProgress('Logging into BrokerBay...', 'Logged in (SSO)');
      return page;
    }
    throw new Error('NTREIS login page did not appear. The login flow may have changed.');
  }

  // Use MLS credentials for NTREIS login
  const userField = await page.$(
    sel('bb.login.ntreisUsernameField', 'input[placeholder="Username"], input[name="username"], input[type="text"]:not([type="hidden"])')
  );
  const passField = await page.$(sel('bb.login.ntreisPassword', 'input[type="password"], input[placeholder="Password"]'));

  if (!userField || !passField) {
    throw new Error('Could not find NTREIS login fields.');
  }

  // Use MLS credentials (NTREIS login is the same as MLS)
  await userField.fill(config.mlsUsername);
  await delay(300);
  await passField.fill(config.mlsPassword);
  await delay(300);

  // Click "Password Login" button
  const loginBtn = await page.$(
    sel('bb.login.passwordLogin', 'button:has-text("Password Login"), button:has-text("Login"), button:has-text("Log In"), button:has-text("Sign In"), button[type="submit"]')
  );
  if (loginBtn) {
    await loginBtn.click();
  } else {
    await passField.press('Enter');
  }

  // Step 4: Wait for redirect back to BrokerBay
  onProgress('Logging into BrokerBay...', 'Waiting for redirect');
  try {
    await page.waitForURL('**edge.brokerbay.com**', { timeout: 30000 });
  } catch {
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch { /* may already be there */ }
  }

  // Verify we're logged in
  await delay(2000);
  const finalUrl = page.url();
  if (finalUrl.includes('auth.') || finalUrl.includes('clareity')) {
    throw new Error('BrokerBay login failed — still on login page after entering credentials.');
  }

  onProgress('Logging into BrokerBay...', 'Logged in');
  await capturePage(page, 'bb-home-after-login');
  return page;
}
