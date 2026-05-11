export function buildEmail(config, data) {
  let template = config.emailTemplate || getDefaultTemplate();

  const {
    metrics,
    totalShowings,
    listDate,
    diff,
    compDescriptions,
    statusNarratives,
    feedback,
    closedStats,
  } = data;

  const newListingsText = buildNewListingsSection(diff.newListings, compDescriptions);
  const statusChangesText = buildStatusChangesSection(diff.statusChanges, statusNarratives);
  const feedbackText = buildFeedbackSection(feedback);

  const replacements = {
    '{SHOWING_COUNT}': metrics.showingCount,
    '{MARKET_SHOWINGS}': metrics.showingsPerListing,
    '{DAYS_ON_MARKET}': metrics.ourDom || '—',
    '{AVG_DOM_ACTIVE}': metrics.avgDomActive ?? '—',
    '{MAX_DOM_ACTIVE}': metrics.maxDomActive ?? '—',
    '{MIN_DOM_ACTIVE}': metrics.minDomActive ?? '—',
    '{TOTAL_SHOWINGS}': totalShowings,
    '{LIST_DATE}': listDate || '—',
    '{NEW_LISTINGS}': newListingsText,
    '{STATUS_CHANGES}': statusChangesText,
    '{AVG_DOM_CLOSED}': closedStats?.avgDomClosed ?? '—',
    '{AVG_SOLD_PRICE}': closedStats?.avgSoldPrice ? formatPrice(closedStats.avgSoldPrice) : '—',
    '{SHOWING_FEEDBACK}': feedbackText,
    '{OPEN_HOUSE_NOTES}': data.openHouseNotes || '',
    '{AGENT_NAME}': config.agentName || '',
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    template = template.replaceAll(placeholder, String(value));
  }

  template = template.replace(/\n{3,}/g, '\n\n');

  return template;
}

function buildNewListingsSection(newListings, descriptions) {
  if (!newListings.length) return '';

  const parts = [];
  const count = newListings.length;
  parts.push(`As ${count === 1 ? 'one new listing has' : `${count} new listings have`} come to the market:`);
  parts.push('');

  for (const listing of newListings) {
    const line = `${listing.address} with ${listing.sqft} square feet, built in ${listing.yearBuilt} on ${listing.lotAcres} acres${listing.hasPool ? ' with a pool' : ' without a pool'}, listed for ${formatPrice(listing.price)}.`;
    parts.push(line);

    const description = descriptions?.[listing.mlsNumber];
    if (description) {
      parts.push(description);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function buildStatusChangesSection(statusChanges, narratives) {
  if (!statusChanges.length) return '';

  const parts = [];
  const underContract = statusChanges.filter((c) =>
    c.status.toLowerCase().includes('option') ||
    c.status.toLowerCase().includes('pending') ||
    c.status.toLowerCase().includes('contingent') ||
    c.status.toLowerCase().includes('kick')
  );

  if (underContract.length) {
    parts.push(`${underContract.length === 1 ? 'One home has' : `${underContract.length} homes have`} gone under contract since our last report:`);
    parts.push('');

    for (const listing of underContract) {
      const narrative = narratives?.[listing.mlsNumber];
      if (narrative) {
        parts.push(narrative);
      } else {
        parts.push(
          `${listing.address} — ${listing.sqft} sq ft, built ${listing.yearBuilt}, ${listing.lotAcres} acres, ${listing.hasPool ? 'pool' : 'no pool'}. Listed for ${formatPrice(listing.price)}, ${listing.dom} days on market. Was ${listing.previousStatus}, now ${listing.status}.`
        );
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

function buildFeedbackSection(feedback) {
  if (!feedback?.length) return 'No showing feedback was received from agents over the past two weeks.';

  const parts = ['Showing feedback received:'];
  for (const fb of feedback) {
    let line = `• ${fb.agent}`;
    if (fb.brokerage) line += ` (${fb.brokerage})`;
    if (fb.rating) line += ` — rated the home's condition ${fb.rating}`;
    if (fb.comments) line += ` — "${fb.comments}"`;
    if (fb.offerIntent) line += `. ${fb.offerIntent}`;
    parts.push(line);
  }
  return parts.join('\n');
}

function formatPrice(price) {
  if (!price) return '$—';
  if (price >= 1000) {
    return `$${price.toLocaleString()}`;
  }
  return `$${(price * 1000).toLocaleString()}`;
}

function getDefaultTemplate() {
  return `We saw {SHOWING_COUNT} showings over the past two weeks versus the market saw {MARKET_SHOWINGS} showings per listing in your area.

You have seen a total of {TOTAL_SHOWINGS} showings since going live on {LIST_DATE}.

We have been on the market for {DAYS_ON_MARKET} days. The average days on market for active listings is {AVG_DOM_ACTIVE} with {MAX_DOM_ACTIVE} being the most and {MIN_DOM_ACTIVE} being the least.

{NEW_LISTINGS}

{STATUS_CHANGES}

{SHOWING_FEEDBACK}

{OPEN_HOUSE_NOTES}

The average days on market for closed homes within the last 90 days is {AVG_DOM_CLOSED} with an average sales price of {AVG_SOLD_PRICE}.

{AGENT_NAME} will reach out to you to discuss this if she hasn't already. Please let us know if you need anything.`;
}
