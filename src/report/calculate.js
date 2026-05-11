export function calculateMarketMetrics(data) {
  const {
    recentShowings,
    totalAreaShowings,
    activeCountPriceSearch,
    comps,
    ourListing,
  } = data;

  const showingCount = recentShowings.length;

  const showingsPerListing = activeCountPriceSearch > 0
    ? (totalAreaShowings / activeCountPriceSearch).toFixed(2)
    : '0.00';

  const outperforming = showingCount > parseFloat(showingsPerListing);

  const activeComps = comps.filter((c) =>
    c.status.toLowerCase().includes('active') &&
    !c.status.toLowerCase().includes('option') &&
    !c.status.toLowerCase().includes('contingent') &&
    !c.status.toLowerCase().includes('kick')
  );

  const domValues = activeComps.map((c) => c.dom).filter(Boolean);
  const avgDomActive = domValues.length
    ? Math.round(domValues.reduce((a, b) => a + b, 0) / domValues.length)
    : null;
  const maxDomActive = domValues.length ? Math.max(...domValues) : null;
  const minDomActive = domValues.length ? Math.min(...domValues) : null;

  const prices = activeComps.map((c) => c.price).filter(Boolean);
  const priceRange = {
    min: prices.length ? Math.min(...prices) : 0,
    max: prices.length ? Math.max(...prices) : 0,
  };

  return {
    showingCount,
    showingsPerListing,
    outperforming,
    ourDom: ourListing?.dom || null,
    avgDomActive,
    maxDomActive,
    minDomActive,
    priceRange,
    activeCount: activeComps.length,
    totalActiveCountPriceSearch: activeCountPriceSearch,
    totalAreaShowings,
  };
}

export function accumulateTotalShowings(db, listingAddress, currentShowingCount) {
  const rows = db
    .prepare('SELECT data_json FROM reports WHERE listing_address = ? ORDER BY run_date ASC')
    .all(listingAddress);

  let total = 0;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json);
      total += data.metrics?.showingCount || 0;
    } catch {
      // skip corrupt rows
    }
  }
  return total + currentShowingCount;
}
