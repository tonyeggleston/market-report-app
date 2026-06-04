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
  path.join(homeDir, 'AppData', 'Local', 'ms-playwright'),       // Windows
  path.join(homeDir, '.cache', 'ms-playwright'),                  // Linux
  path.join(homeDir, 'Library', 'Caches', 'ms-playwright'),      // macOS
  process.env.PLAYWRIGHT_BROWSERS_PATH,
].filter(Boolean);

function findBrowserDir(preferFull) {
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter(e => e.startsWith('chromium'));

    if (preferFull) {
      const fullBrowser = entries
        .filter(e => !e.includes('headless_shell'))
        .sort().reverse();
      if (fullBrowser.length) return path.join(dir, fullBrowser[0]);
    }

    const headlessShell = entries
      .filter(e => e.includes('headless_shell'))
      .sort().reverse();
    if (headlessShell.length) return path.join(dir, headlessShell[0]);

    const any = entries.sort().reverse();
    if (any.length) return path.join(dir, any[0]);
  }
  return null;
}

// Prefer the full chromium browser; fall back to headless shell
let browserPath = findBrowserDir(true);

if (!browserPath) {
  console.log('Chromium not found locally. Installing via Playwright...');
  execSync('npx playwright install chromium', { cwd: projectRoot, stdio: 'inherit' });
  browserPath = findBrowserDir(true);
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

// Find all executables so we know what browser-path.js should look for
const allExes = [];
function walkForExe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkForExe(full);
    else if (/^(chrome|chromium|chrome-headless-shell|Google Chrome for Testing)(\.exe)?$/i.test(entry.name))
      allExes.push(path.relative(destDir, full));
  }
}
walkForExe(destDir);

if (allExes.length) {
  console.log('Browser executables found:', allExes.join(', '));
} else {
  console.warn('WARNING: No browser executable found in bundle.');
}

let sizeCmd;
if (process.platform === 'win32') {
  sizeCmd = `powershell -command "(Get-ChildItem -Recurse '${destDir}' | Measure-Object -Property Length -Sum).Sum"`;
} else if (process.platform === 'darwin') {
  // macOS du doesn't support -b; use find + stat instead
  sizeCmd = `find "${destDir}" -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s}'`;
} else {
  sizeCmd = `du -sb "${destDir}" | cut -f1`;
}
const totalSize = parseInt(execSync(sizeCmd, { encoding: 'utf8' }).trim(), 10);

console.log(`Chromium bundle size: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);
console.log('Done.');
