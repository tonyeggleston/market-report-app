export function computeDiff(currentComps, previousComps) {
  const prevByMls = new Map(
    (previousComps || []).map((c) => [c.mlsNumber, c])
  );

  const newListings = [];
  const statusChanges = [];
  const priceChanges = [];
  const carriedForward = [];

  for (const comp of currentComps) {
    const prev = prevByMls.get(comp.mlsNumber);

    if (!prev) {
      newListings.push({ ...comp, isNew: true });
    } else {
      if (prev.status !== comp.status) {
        statusChanges.push({
          ...comp,
          previousStatus: prev.status,
          previousPrice: prev.price,
        });
      }

      if (prev.price !== comp.price) {
        priceChanges.push({
          ...comp,
          previousPrice: prev.price,
          priceDirection: comp.price < prev.price ? 'reduced' : 'increased',
        });
      }

      carriedForward.push(comp);
    }
  }

  const removedListings = [];
  for (const [mlsNumber, prev] of prevByMls) {
    const stillPresent = currentComps.some((c) => c.mlsNumber === mlsNumber);
    if (!stillPresent) {
      removedListings.push({ ...prev, removedReason: 'No longer in search results' });
    }
  }

  return {
    newListings,
    statusChanges,
    priceChanges,
    carriedForward,
    removedListings,
    summary: {
      newCount: newListings.length,
      statusChangeCount: statusChanges.length,
      priceChangeCount: priceChanges.length,
      carriedForwardCount: carriedForward.length,
      removedCount: removedListings.length,
    },
  };
}
