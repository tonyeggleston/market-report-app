import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const CONFIG_DIR = path.join(app.getPath('userData'), 'market-report');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.enc');
const KEY_FILE = path.join(CONFIG_DIR, '.key');

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function getEncryptionKey() {
  ensureDir();
  if (fs.existsSync(KEY_FILE)) {
    return fs.readFileSync(KEY_FILE);
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key);
  // On Windows, hide the key file to discourage casual access
  if (process.platform === 'win32') {
    try {
      execSync(`attrib +H "${KEY_FILE}"`, { stdio: 'ignore' });
    } catch { /* best effort */ }
  } else {
    try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* best effort */ }
  }
  return key;
}

export function getConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return null;

  const key = getEncryptionKey();
  const raw = fs.readFileSync(CONFIG_FILE);
  const iv = raw.subarray(0, 16);
  const encrypted = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

export function saveConfig(config) {
  ensureDir();
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(config), 'utf8'),
    cipher.final(),
  ]);
  fs.writeFileSync(CONFIG_FILE, Buffer.concat([iv, encrypted]), { mode: 0o600 });
}

export function isSetupComplete() {
  const config = getConfig();
  if (!config) return false;
  return !!(config.mlsUsername && config.brokerBayUsername && config.emailTemplate);
}
