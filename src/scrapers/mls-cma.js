import path from 'node:path';

export async function selectCompsAndDownloadCma(page, selectedMlsNumbers, outputDir, onProgress) {
  onProgress('Generating CMA...', `Selecting ${selectedMlsNumbers.length} comps`);

  await page.evaluate((mlsNumbers) => {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const row = cb.closest('tr');
      if (!row) continue;
      const rowText = row.textContent;
      const isSelected = mlsNumbers.some((mls) => rowText.includes(mls));
      if (isSelected && !cb.checked) {
        cb.click();
      } else if (!isSelected && cb.checked) {
        cb.click();
      }
    }
  }, selectedMlsNumbers);

  await page.waitForTimeout(500);

  onProgress('Generating CMA...', 'Clicking Quick CMA');

  const cmaBtn = await page.$(
    'a:has-text("Quick CMA"), button:has-text("Quick CMA"), a:has-text("CMA"), input[value*="CMA"]'
  );

  if (!cmaBtn) {
    onProgress('Generating CMA...', 'Quick CMA button not found — skipping PDF');
    return null;
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await cmaBtn.click();
  const download = await downloadPromise;

  if (!download) {
    onProgress('Generating CMA...', 'No download triggered — CMA may have opened in new tab');
    return null;
  }

  const suggestedName = download.suggestedFilename() || 'cma-report.pdf';
  const cmaPdfPath = path.join(outputDir, suggestedName);
  await download.saveAs(cmaPdfPath);

  onProgress('Generating CMA...', `Saved: ${suggestedName}`);
  return cmaPdfPath;
}
