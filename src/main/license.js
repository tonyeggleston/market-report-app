import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const LICENSE_DIR = path.join(app.getPath('userData'), 'market-report');
const LICENSE_FILE = path.join(LICENSE_DIR, '.license');

// Default — override with your Vercel deployment URL
const API_BASE = process.env.MR_LICENSE_API || 'https://marketpulse.commandmodule.com';

// ─── Local license storage ───

function readLocalLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null;
    return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLocalLicense(data) {
  fs.mkdirSync(LICENSE_DIR, { recursive: true });
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ─── API calls ───

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const payload = JSON.stringify(body);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `API error ${res.statusCode}`));
          }
        } catch {
          reject(new Error(`Invalid API response (HTTP ${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('License server timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── Public API ───

/**
 * Get the stored license key (if any).
 */
export function getLicenseKey() {
  const local = readLocalLicense();
  return local?.licenseKey || null;
}

/**
 * Save a license key locally (entered during setup or settings).
 */
export function saveLicenseKey(licenseKey) {
  const local = readLocalLicense() || {};
  local.licenseKey = licenseKey.trim();
  writeLocalLicense(local);
}

/**
 * Validate the license with the server.
 * Returns: { active, plan, reportsIncluded, reportsUsed, overageRate, billingPeriodEnd, message }
 * On network failure, falls back to cached status (grace period).
 */
export async function validateLicense() {
  const licenseKey = getLicenseKey();
  if (!licenseKey) {
    return { active: false, reason: 'no-key', message: 'No license key found. Enter your license key in Settings.' };
  }

  try {
    const result = await apiPost('/api/validate', { licenseKey });

    // Cache the result locally for offline grace period
    const local = readLocalLicense() || {};
    local.licenseKey = licenseKey;
    local.lastValidation = new Date().toISOString();
    local.cachedStatus = result;
    writeLocalLicense(local);

    return result;
  } catch (err) {
    // Network failure — use cached status with grace period (7 days)
    const local = readLocalLicense();
    if (local?.cachedStatus && local?.lastValidation) {
      const lastCheck = new Date(local.lastValidation);
      const daysSince = (Date.now() - lastCheck.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince <= 7) {
        return {
          ...local.cachedStatus,
          offline: true,
          message: `Using cached license (last verified ${Math.round(daysSince)} days ago). Connect to the internet to re-validate.`,
        };
      }
    }

    return {
      active: false,
      reason: 'network-error',
      message: `Could not reach the license server: ${err.message}. Check your internet connection.`,
    };
  }
}

/**
 * Check if the user can run a report right now.
 * Returns: { allowed, needsOverageConfirm, overageRate, reportsUsed, reportsIncluded, message }
 */
export async function canRunReport() {
  const status = await validateLicense();

  if (!status.active) {
    return { allowed: false, message: status.message || 'Your subscription is not active.' };
  }

  const used = status.reportsUsed || 0;
  const included = status.reportsIncluded || 0;
  const overageRate = status.overageRate || 0;

  if (used < included) {
    return {
      allowed: true,
      reportsUsed: used,
      reportsIncluded: included,
      message: `Report ${used + 1} of ${included} included this period.`,
    };
  }

  // Over quota — needs confirmation for overage billing
  return {
    allowed: true,
    needsOverageConfirm: true,
    overageRate,
    reportsUsed: used,
    reportsIncluded: included,
    message: `You've used all ${included} reports included in your plan. This report will be billed at $${overageRate.toFixed(2)}.`,
  };
}

/**
 * Notify the server that a report was completed.
 * This increments the usage counter and triggers overage billing if applicable.
 */
export async function reportCompleted(listingAddress) {
  const licenseKey = getLicenseKey();
  if (!licenseKey) return;

  try {
    const result = await apiPost('/api/report-complete', {
      licenseKey,
      listingAddress,
      completedAt: new Date().toISOString(),
    });
    return result;
  } catch {
    // Non-blocking — report still generated even if billing call fails.
    // Server will reconcile on next validation.
  }
}

/**
 * Activate a new license key (first-time setup).
 * Returns the subscription details or throws.
 */
export async function activateLicense(licenseKey) {
  const result = await apiPost('/api/activate', { licenseKey: licenseKey.trim() });

  if (result.active) {
    saveLicenseKey(licenseKey);
    const local = readLocalLicense() || {};
    local.lastValidation = new Date().toISOString();
    local.cachedStatus = result;
    writeLocalLicense(local);
  }

  return result;
}
