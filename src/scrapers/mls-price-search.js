import { sel } from './selectors.js';

export async function runPriceOnlySearch(page, priceMin, priceMax, onProgress) {
  onProgress('Running price-only search...', `$${priceMin} – $${priceMax} (mirroring BrokerBay)`);

  const criteriaBtn = await page.$(
    sel('mls.priceSearch.criteria', 'a:has-text("Criteria"), button:has-text("Criteria"), a:has-text("Modify"), #criteriaLink')
  );
  if (criteriaBtn) {
    await criteriaBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const sqftFields = await page.$$(
    sel('mls.priceSearch.sqftFields', 'input[name*="sqft"], input[name*="SqFt"], input[name*="square"], input[id*="sqft"], input[id*="SqFt"]')
  );
  for (const field of sqftFields) {
    await field.fill('');
  }

  const yearFields = await page.$$(
    sel('mls.priceSearch.yearFields', 'input[name*="year"], input[name*="Year"], input[id*="year"], input[id*="Year"]')
  );
  for (const field of yearFields) {
    await field.fill('');
  }

  const priceMinField = await page.$(
    sel('mls.priceSearch.priceMin', 'input[name*="priceMin"], input[name*="PriceMin"], input[name*="price_min"], input[id*="priceMin"], input[id*="PriceMin"], input[placeholder*="Min"]')
  );
  const priceMaxField = await page.$(
    sel('mls.priceSearch.priceMax', 'input[name*="priceMax"], input[name*="PriceMax"], input[name*="price_max"], input[id*="priceMax"], input[id*="PriceMax"], input[placeholder*="Max"]')
  );

  if (priceMinField) await priceMinField.fill(String(Math.round(priceMin)));
  if (priceMaxField) await priceMaxField.fill(String(Math.round(priceMax)));

  const resultsBtn = await page.$(
    sel('mls.priceSearch.resultsButton', 'button:has-text("Results"), input[value="Results"], a:has-text("Results")')
  );
  if (resultsBtn) {
    await resultsBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const rowSel = sel('mls.results.rows', 'table.display tbody tr, table.results tbody tr, tr[class*="listing"], table tbody tr');
  const activeCount = await page.evaluate((rowSelector) => {
    const rows = document.querySelectorAll(rowSelector);
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
  }, rowSel);

  onProgress('Running price-only search...', `${activeCount} active listings in price range`);
  return { activeCount, priceMin, priceMax };
}
