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

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

  const loginFailed = await validateLogin(page);
  if (loginFailed) {
    throw new Error(`MLS login failed: ${loginFailed}`);
  }

  onProgress('Logging into MLS...', 'Logged in');
  return page;
}
