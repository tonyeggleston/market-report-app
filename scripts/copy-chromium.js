/**
 * Copies Playwright's Chromium into build-resources/chromium/ so
 * electron-builder bundles it inside the installer.
 *
 * Run: node scripts/copy-chromium.js
 * Called automatically as the "prebuild" npm script.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const destDir = path.join(projectRoot, 'build-resources', 'chromium');

const homeDir = process.env.HOME || process.env.USERPROFILE;

const searchDirs = [
  path.join(homeDir, 'AppData', 'Local', 'ms-playwright'),
  path.join(homeDir, '.cache', 'ms-playwright'),
  process.env.PLAYWRIGHT_BROWSERS_PATH,
].filter(Boolean);

function findChromium() {
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir)
      .filter(e => e.startsWith('chromium'))
      .sort()
      .reverse();
    if (entries.length) return path.join(dir, entries[0]);
  }
  return null;
}

let browserPath = findChromium();

if (!browserPath) {
  console.log('Chromium not found locally. Installing via Playwright...');
  execSync('npx playwright install chromium', { cwd: projectRoot, stdio: 'inherit' });
  browserPath = findChromium();
}

if (!browserPath) {
  throw new Error('Could not locate Playwright Chromium after install.');
}

if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true });
}

console.log(`Source: ${browserPath}`);
console.log(`Dest:   ${destDir}`);

fs.cpSync(browserPath, destDir, { recursive: true });

const allExes = [];
function walkForExe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkForExe(full);
    else if (entry.name === 'chrome.exe' || entry.name === 'chromium' || entry.name === 'chromium.exe')
      allExes.push(path.relative(destDir, full));
  }
}
walkForExe(destDir);

if (allExes.length) {
  console.log('Browser executables found:', allExes.join(', '));
} else {
  console.warn('WARNING: No chrome/chromium executable found in bundle. Check browser-path.js paths.');
}

const totalSize = parseInt(execSync(
  process.platform === 'win32'
    ? `powershell -command "(Get-ChildItem -Recurse '${destDir}' | Measure-Object -Property Length -Sum).Sum"`
    : `du -sb "${destDir}" | cut -f1`
, { encoding: 'utf8' }).trim(), 10);

console.log(`Chromium bundle size: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);
console.log('Done.');
