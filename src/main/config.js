import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_DIR = path.join(app.getPath('userData'), 'market-report');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.enc');
const KEY_FILE = path.join(CONFIG_DIR, '.key');

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ─── Preferred: Electron safeStorage (DPAPI on Windows, Keychain on macOS) ───

function useSafeStorage() {
  return safeStorage.isEncryptionAvailable();
}

// ─── Fallback: AES-256-GCM with key file (Linux without keyring) ───

let cachedKey = null;

function getEncryptionKey() {
  if (cachedKey) return cachedKey;
  ensureDir();
  if (fs.existsSync(KEY_FILE)) {
    cachedKey = fs.readFileSync(KEY_FILE);
    return cachedKey;
  }
  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, cachedKey, { mode: 0o600 });
  return cachedKey;
}

function encryptGcm(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [12-byte IV][16-byte auth tag][ciphertext]
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptGcm(raw) {
  const key = getEncryptionKey();
  if (raw.length < 29) return null; // 12 + 16 + at least 1 byte
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ─── Legacy AES-256-CBC (read-only, for migration from old format) ───

function decryptLegacyCbc(raw) {
  const key = getEncryptionKey();
  if (raw.length < 17) return null;
  const iv = raw.subarray(0, 16);
  const encrypted = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function getConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return null;

  try {
    const raw = fs.readFileSync(CONFIG_FILE);

    // Try safeStorage first (preferred on Windows/macOS)
    if (useSafeStorage()) {
      try {
        const decrypted = safeStorage.decryptString(raw);
        return JSON.parse(decrypted);
      } catch { /* not safeStorage format — try legacy formats */ }
    }

    // Try AES-256-GCM (fallback format)
    try {
      const decrypted = decryptGcm(raw);
      if (decrypted) {
        const config = JSON.parse(decrypted);
        // Migrate to safeStorage if now available
        if (useSafeStorage()) saveConfig(config);
        return config;
      }
    } catch { /* not GCM format */ }

    // Try legacy AES-256-CBC (old format before security upgrade)
    try {
      const decrypted = decryptLegacyCbc(raw);
      if (decrypted) {
        const config = JSON.parse(decrypted);
        // Migrate to new format on next save
        saveConfig(config);
        return config;
      }
    } catch { /* corrupt */ }

    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  ensureDir();
  const json = JSON.stringify(config);

  if (useSafeStorage()) {
    const encrypted = safeStorage.encryptString(json);
    fs.writeFileSync(CONFIG_FILE, encrypted, { mode: 0o600 });
    // Clean up old key file — no longer needed with OS-level encryption
    if (fs.existsSync(KEY_FILE)) {
      try { fs.unlinkSync(KEY_FILE); } catch { /* best effort */ }
    }
  } else {
    // Fallback: AES-256-GCM with key file (authenticated encryption)
    const encrypted = encryptGcm(json);
    fs.writeFileSync(CONFIG_FILE, encrypted, { mode: 0o600 });
  }
}

export function isSetupComplete() {
  const config = getConfig();
  if (!config) return false;
  return !!(config.mlsUsername && config.brokerBayUsername && config.emailTemplate);
}
