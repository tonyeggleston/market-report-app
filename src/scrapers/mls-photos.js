import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { sel } from './selectors.js';
import { capturePage } from './capture.js';

export async function downloadListingPhotos(page, mlsNumber, outputDir, onProgress) {
  const photoDir = path.join(outputDir, 'photos', mlsNumber);
  fs.mkdirSync(photoDir, { recursive: true });

  const mlsLink = await page.$(
    sel('mls.listingLink', `a:has-text("${mlsNumber}"), td:has-text("${mlsNumber}") a, a[href*="${mlsNumber}"]`)
  );

  if (!mlsLink) {
    onProgress('Downloading photos...', `No link found for ${mlsNumber}`);
    return { mlsNumber, photos: [], photoDir };
  }

  const [newPage] = await Promise.all([
    page.context().waitForEvent('page').catch(() => null),
    mlsLink.click({ modifiers: ['Control'] }).catch(() => mlsLink.click()),
  ]);

  const detailPage = newPage || page;
  await detailPage.waitForLoadState('domcontentloaded').catch(() => {});

  // Diagnostic: save the first listing detail page so photo/detail selectors
  // can be verified against the real Matrix markup.
  try {
    const debugFlag = path.join(outputDir, 'debug-listing-detail.html');
    if (!fs.existsSync(debugFlag)) {
      const html = await detailPage.content();
      fs.writeFileSync(debugFlag, html);
      await detailPage.screenshot({ path: path.join(outputDir, 'debug-listing-detail.png'), fullPage: true }).catch(() => {});
    }
  } catch { /* best-effort */ }

  // Capture mode: save EVERY listing detail page so all selectors can be fixed
  // against real markup in one pass.
  await capturePage(detailPage, `listing-detail-${mlsNumber}`);

  const photoImgSel = sel('mls.photos.images', 'img[src*="photo"], img[src*="Photo"], img[src*="image"], img[src*="listing"], img[class*="photo"], img[class*="listing"]');
  const photoLinkSel = sel('mls.photos.links', 'a[href*="photo"], a[href*="Photo"]');
  const photoUrls = await detailPage.evaluate(({ imgSel, linkSel }) => {
    const imgs = document.querySelectorAll(imgSel);

    const urls = new Set();
    for (const img of imgs) {
      const src = img.src || img.dataset.src || img.dataset.original || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar')) {
        let fullSrc = src;
        if (src.includes('_thumb') || src.includes('_small') || src.includes('_tn')) {
          fullSrc = src
            .replace('_thumb', '_large')
            .replace('_small', '_large')
            .replace('_tn', '_large');
        }
        urls.add(fullSrc);
      }
    }

    const links = document.querySelectorAll(linkSel);
    for (const link of links) {
      if (link.href) urls.add(link.href);
    }

    return Array.from(urls).slice(0, 40);
  }, { imgSel: photoImgSel, linkSel: photoLinkSel });

  onProgress('Downloading photos...', `${mlsNumber}: ${photoUrls.length} photos found`);

  const photos = [];
  for (let i = 0; i < photoUrls.length; i++) {
    const url = photoUrls[i];
    const ext = url.match(/\.(jpe?g|png|webp)/i)?.[1] || 'jpg';
    const filename = `photo_${String(i + 1).padStart(2, '0')}.${ext}`;
    const filepath = path.join(photoDir, filename);

    try {
      await downloadFile(url, filepath);
      photos.push({ index: i, filename, filepath, url });
    } catch {
      // skip failed downloads
    }
  }

  if (newPage && newPage !== page) {
    await newPage.close();
  }

  return { mlsNumber, photos, photoDir };
}

function downloadFile(url, dest, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'));
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client.get(url, { timeout: 10000 }, (response) => {
      const code = response.statusCode;
      if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
        response.resume(); // drain the response
        const redirectUrl = new URL(response.headers.location, url).href;
        downloadFile(redirectUrl, dest, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => {
        fs.unlink(dest, () => {}); // async cleanup, ignore errors
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {}); // async cleanup, ignore errors
      reject(err);
    });
  });
}
