export async function pullMarketTrends(page, config, neighborhoodName, priceRange, onProgress) {
  onProgress('Pulling market trends...', 'Navigating to Analytics');

  const analyticsLink = await page.$(
    'a:has-text("Analytics"), [href*="analytics"], button:has-text("Analytics"), nav a:has-text("Analytics")'
  );
  if (analyticsLink) {
    await analyticsLink.click();
    await page.waitForLoadState('networkidle');
  }

  const marketTrendsLink = await page.$(
    'a:has-text("Market Trends"), button:has-text("Market Trends"), [href*="market-trends"], [href*="marketTrends"]'
  );
  if (marketTrendsLink) {
    await marketTrendsLink.click();
    await page.waitForLoadState('networkidle');
  }

  await page.waitForTimeout(1500);

  // Step 1: Set custom date range to 2 weeks
  onProgress('Pulling market trends...', 'Setting date range to 2 weeks');

  const dateRangeBtn = await page.$(
    '[class*="date-range"], button:has-text("Custom"), [class*="DateRange"], button:has-text("Date"), [class*="dateRange"]'
  );
  if (dateRangeBtn) {
    await dateRangeBtn.click();
    await page.waitForTimeout(1000);

    const today = new Date();
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(today.getDate() - 14);

    const startInput = await page.$(
      'input[name*="start"], input[name*="from"], input[placeholder*="Start"], input[placeholder*="From"]'
    );
    const endInput = await page.$(
      'input[name*="end"], input[name*="to"], input[placeholder*="End"], input[placeholder*="To"]'
    );

    if (startInput) await startInput.fill(formatDate(twoWeeksAgo));
    if (endInput) await endInput.fill(formatDate(today));

    const submitDateBtn = await page.$(
      'button:has-text("Submit"), button:has-text("Apply"), button:has-text("Update")'
    );
    if (submitDateBtn) {
      await submitDateBtn.click();
      await page.waitForTimeout(1500);
    }
  }

  // Step 2: Add area → Custom → search neighborhood
  onProgress('Pulling market trends...', `Setting area to "${neighborhoodName}"`);

  const addAreaBtn = await page.$(
    'button:has-text("Add Area"), a:has-text("Add Area"), button:has-text("Add")'
  );
  if (addAreaBtn) {
    await addAreaBtn.click();
    await page.waitForTimeout(1000);

    const customBtn = await page.$(
      'button:has-text("Custom"), a:has-text("Custom"), li:has-text("Custom")'
    );
    if (customBtn) {
      await customBtn.click();
      await page.waitForTimeout(500);
    }

    const areaSearchInput = await page.$(
      'input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]'
    );
    if (areaSearchInput) {
      await areaSearchInput.fill(neighborhoodName);
      await page.waitForTimeout(1500);

      const areaResult = await page.$(
        `li:has-text("${neighborhoodName}"), div:has-text("${neighborhoodName}"), a:has-text("${neighborhoodName}")`
      );
      if (areaResult) {
        await areaResult.click();
        await page.waitForTimeout(1000);
      }
    }
  }

  // Step 3: Set filters — Sale, Residential, Single Family
  onProgress('Pulling market trends...', 'Setting filters (Sale, Residential, Single Family)');

  const saleDropdown = await page.$(
    'select:has(option[value="sale"]), select:has(option:has-text("Sale")), [class*="listing-type"] select'
  );
  if (saleDropdown) {
    await saleDropdown.selectOption({ label: 'Sale' }).catch(() =>
      saleDropdown.selectOption('sale').catch(() => {})
    );
  }

  const propertyType = await page.$(
    'select:has(option[value="residential"]), select:has(option:has-text("Residential")), [class*="property-type"] select'
  );
  if (propertyType) {
    await propertyType.selectOption({ label: 'Residential' }).catch(() =>
      propertyType.selectOption('residential').catch(() => {})
    );
  }

  const singleFamilyOption = await page.$(
    'input[value="single_family"], input[value="Single Family"], label:has-text("Single Family") input'
  );
  if (singleFamilyOption) {
    const isChecked = await singleFamilyOption.isChecked();
    if (!isChecked) await singleFamilyOption.click();
  }

  // Step 4: Set price range (because sqft filter is broken)
  onProgress('Pulling market trends...', `Price range: $${priceRange.min}K – $${priceRange.max}K`);

  const minPriceInput = await page.$(
    'input[name*="priceMin"], input[name*="min_price"], input[placeholder*="Min Price"], input[placeholder*="Min"]'
  );
  const maxPriceInput = await page.$(
    'input[name*="priceMax"], input[name*="max_price"], input[placeholder*="Max Price"], input[placeholder*="Max"]'
  );

  if (minPriceInput) await minPriceInput.fill(String(Math.round(priceRange.min)));
  if (maxPriceInput) await maxPriceInput.fill(String(Math.round(priceRange.max)));

  const saveBtn = await page.$(
    'button:has-text("Save"), button:has-text("Apply"), button:has-text("Submit"), button:has-text("Update")'
  );
  if (saveBtn) {
    await saveBtn.click();
    await page.waitForLoadState('networkidle');
  }

  await page.waitForTimeout(2000);

  // Step 5: Read total showings
  const totalAreaShowings = await page.evaluate(() => {
    const text = document.body.innerText;

    const showingPatterns = [
      /(\d+)\s*total\s*showings/i,
      /total\s*showings[:\s]*(\d+)/i,
      /showings[:\s]*(\d+)/i,
      /(\d+)\s*showings/i,
    ];

    for (const pattern of showingPatterns) {
      const match = text.match(pattern);
      if (match) return parseInt(match[1]);
    }

    const numbers = document.querySelectorAll(
      '[class*="total"], [class*="count"], [class*="showing"] [class*="number"], h2, h3'
    );
    for (const el of numbers) {
      const val = parseInt(el.textContent.replace(/\D/g, ''));
      if (val > 0 && val < 1000) return val;
    }

    return 0;
  });

  onProgress('Pulling market trends...', `${totalAreaShowings} total area showings in 2 weeks`);

  return { totalAreaShowings };
}

function formatDate(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  return `${m}/${d}/${y}`;
}
