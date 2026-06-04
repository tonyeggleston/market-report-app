export async function runPriceOnlySearch(page, priceMin, priceMax, onProgress) {
  onProgress('Running price-only search...', `$${priceMin} – $${priceMax} (mirroring BrokerBay)`);

  const criteriaBtn = await page.$(
    'a:has-text("Criteria"), button:has-text("Criteria"), a:has-text("Modify"), #criteriaLink'
  );
  if (criteriaBtn) {
    await criteriaBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const sqftFields = await page.$$(
    'input[name*="sqft"], input[name*="SqFt"], input[name*="square"], input[id*="sqft"], input[id*="SqFt"]'
  );
  for (const field of sqftFields) {
    await field.fill('');
  }

  const yearFields = await page.$$(
    'input[name*="year"], input[name*="Year"], input[id*="year"], input[id*="Year"]'
  );
  for (const field of yearFields) {
    await field.fill('');
  }

  const priceMinField = await page.$(
    'input[name*="priceMin"], input[name*="PriceMin"], input[name*="price_min"], input[id*="priceMin"], input[id*="PriceMin"], input[placeholder*="Min"]'
  );
  const priceMaxField = await page.$(
    'input[name*="priceMax"], input[name*="PriceMax"], input[name*="price_max"], input[id*="priceMax"], input[id*="PriceMax"], input[placeholder*="Max"]'
  );

  if (priceMinField) await priceMinField.fill(String(Math.round(priceMin)));
  if (priceMaxField) await priceMaxField.fill(String(Math.round(priceMax)));

  const resultsBtn = await page.$(
    'button:has-text("Results"), input[value="Results"], a:has-text("Results")'
  );
  if (resultsBtn) {
    await resultsBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const activeCount = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      'table.display tbody tr, table.results tbody tr, tr[class*="listing"], table tbody tr'
    );
    let count = 0;
    for (const row of rows) {
      const text = row.textContent.toLowerCase();
      if (text.includes('active') && !text.includes('option') && !text.includes('contingent') && !text.includes('kick')) {
        count++;
      }
    }
    if (count === 0) {
      count = rows.length;
    }
    return count;
  });

  onProgress('Running price-only search...', `${activeCount} active listings in price range`);
  return { activeCount, priceMin, priceMax };
}
