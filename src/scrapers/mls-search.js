export async function runSavedSearch(page, listingAddress, onProgress) {
  onProgress('Running saved search...', `Looking for "${listingAddress}"`);

  const savedSearchLink = await page.$(
    'a:has-text("Saved Searches"), a[href*="SavedSearch"], a[href*="saved"], #savedSearches'
  );
  if (savedSearchLink) {
    await savedSearchLink.click();
    await page.waitForLoadState('networkidle');
  }

  await page.waitForTimeout(1500);

  const searchInput = await page.$(
    'input[type="text"][name*="search"], input[placeholder*="Search"], input[placeholder*="search"], #searchInput'
  );
  if (searchInput) {
    await searchInput.fill(listingAddress);
    await page.waitForTimeout(1500);
  }

  const searchLink = await page.$(`a:has-text("${listingAddress}"), td:has-text("${listingAddress}")`);
  if (searchLink) {
    await searchLink.click();
    await page.waitForTimeout(2000);
  }

  const resultsBtn = await page.$(
    'button:has-text("Results"), input[value="Results"], a:has-text("Results"), #resultsButton'
  );
  if (resultsBtn) {
    await resultsBtn.click();
    await page.waitForLoadState('networkidle');
  }

  onProgress('Running saved search...', 'Results loaded');
  return page;
}

export async function switchToAgentSingleLine(page) {
  const agentLineBtn = await page.$(
    'a:has-text("Agent Single Line"), button:has-text("Agent Single Line"), a:has-text("Agt Single"), select option:has-text("Agent Single")'
  );
  if (agentLineBtn) {
    await agentLineBtn.click();
    await page.waitForLoadState('networkidle');
  }
  return page;
}

export async function extractCompRows(page, onProgress) {
  onProgress('Extracting comp data...', 'Reading listing rows');

  const comps = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      'table.display tbody tr, table.results tbody tr, tr[class*="listing"], table tbody tr'
    );
    const results = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;

      const getText = (el) => el?.textContent?.trim() || '';
      const getNum = (el) => {
        const raw = getText(el).replace(/[^0-9.-]/g, '');
        return parseFloat(raw) || 0;
      };

      const checkbox = row.querySelector('input[type="checkbox"]');

      results.push({
        mlsNumber: getText(cells[0]).replace(/\D/g, '') ? getText(cells[0]) : getText(cells[1]),
        address: getText(cells[1]) || getText(cells[2]),
        status: getText(cells[2]) || getText(cells[3]),
        price: getNum(cells[3]) || getNum(cells[4]),
        sqft: getNum(cells[4]) || getNum(cells[5]),
        yearBuilt: getNum(cells[5]) || getNum(cells[6]),
        lotAcres: getNum(cells[6]) || getNum(cells[7]),
        hasPool: (() => {
          for (const cell of cells) {
            const t = getText(cell).toLowerCase();
            if (t === 'y' || t === 'yes' || t === 'pool') return true;
          }
          return false;
        })(),
        dom: (() => {
          // Look for DOM in later columns (typically after price/sqft/year/lot)
          // Skip early columns that contain MLS#, address, status, price, sqft, yearBuilt, lotAcres
          const startIdx = Math.min(7, cells.length - 1);
          for (let ci = startIdx; ci < cells.length; ci++) {
            const t = getText(cells[ci]);
            if (/^\d+$/.test(t) && parseInt(t) < 500) return parseInt(t);
          }
          return 0;
        })(),
        flag: (() => {
          for (const cell of cells) {
            const t = getText(cell).toUpperCase();
            if (t === 'N' || t === 'NEW') return 'N';
          }
          return '';
        })(),
        rowIndex: Array.from(rows).indexOf(row),
        hasCheckbox: !!checkbox,
        checkboxSelector: checkbox ? `tr:nth-child(${Array.from(rows).indexOf(row) + 1}) input[type="checkbox"]` : null,
      });
    }
    return results;
  });

  onProgress('Extracting comp data...', `Found ${comps.length} listings`);
  return comps;
}

export async function extractStats(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;

    const findStat = (pattern) => {
      const match = text.match(pattern);
      return match ? parseInt(match[1]) : null;
    };

    return {
      avgDomActive: findStat(/average[:\s]*(\d+)/i),
      maxDomActive: findStat(/max(?:imum)?[:\s]*(\d+)/i),
      minDomActive: findStat(/min(?:imum)?[:\s]*(\d+)/i),
    };
  });
}

export async function extractClosedStats(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;

    const findStat = (pattern) => {
      const match = text.match(pattern);
      return match ? parseFloat(match[1].replace(/,/g, '')) : null;
    };

    return {
      avgDomClosed: findStat(/average[:\s]*(\d+)/i),
      avgSoldPrice: findStat(/average\s*(?:sold\s*)?price[:\s]*\$?([\d,]+)/i),
    };
  });
}
