import fs from 'node:fs';
import path from 'node:path';

// Capture the full rendered HTML + a screenshot of a page into the run's
// output folder. Used by "capture mode" so the operator can send back the
// real DOM of every page in the flow — letting selectors be fixed against
// reality in one pass instead of one rebuild per page.

let captureEnabled = false;
let captureDir = null;
let seq = 0;

export function initCapture(enabled, outputDir) {
  captureEnabled = !!enabled;
  seq = 0;
  if (captureEnabled) {
    captureDir = path.join(outputDir, 'capture');
    fs.mkdirSync(captureDir, { recursive: true });
  }
}

export function isCaptureOn() {
  return captureEnabled;
}

// Save the given page. `name` is a short slug describing the step.
export async function capturePage(page, name) {
  if (!captureEnabled || !page) return;
  seq += 1;
  const slug = `${String(seq).padStart(2, '0')}-${String(name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(captureDir, `${slug}.html`), html);
  } catch { /* best effort */ }
  try {
    await page.screenshot({ path: path.join(captureDir, `${slug}.png`), fullPage: true });
  } catch { /* best effort */ }
  try {
    fs.writeFileSync(path.join(captureDir, `${slug}.url.txt`), page.url());
  } catch { /* best effort */ }
}
