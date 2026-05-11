import fs from 'node:fs';
import path from 'node:path';

export function buildEmail(config, data) {
  const plainText = buildPlainText(config, data);
  const html = buildHtml(config, data);
  return { plainText, html };
}

function buildPlainText(config, data) {
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

  const newListingsText = buildNewListingsPlain(diff.newListings, compDescriptions);
  const statusChangesText = buildStatusChangesPlain(diff.statusChanges, statusNarratives);
  const feedbackText = buildFeedbackPlain(feedback);

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

  return template.replace(/\n{3,}/g, '\n\n');
}

function buildHtml(config, data) {
  const {
    metrics,
    totalShowings,
    listDate,
    diff,
    compDescriptions,
    statusNarratives,
    feedback,
    closedStats,
    photosByMls,
  } = data;

  const parts = [];

  parts.push(`<div style="font-family: Calibri, Arial, sans-serif; font-size: 14px; color: #1a1a1a; line-height: 1.6; max-width: 700px;">`);

  parts.push(`<p>We saw <strong>${metrics.showingCount}</strong> showings over the past two weeks versus the market saw <strong>${metrics.showingsPerListing}</strong> showings per listing in your area.</p>`);

  parts.push(`<p>You have seen a total of <strong>${totalShowings}</strong> showings since going live on ${listDate || '—'}.</p>`);

  parts.push(`<p>We have been on the market for <strong>${metrics.ourDom || '—'}</strong> days. The average days on market for active listings is ${metrics.avgDomActive ?? '—'} with ${metrics.maxDomActive ?? '—'} being the most and ${metrics.minDomActive ?? '—'} being the least.</p>`);

  // New listings with photos
  if (diff.newListings.length) {
    const count = diff.newListings.length;
    parts.push(`<p><strong>${count === 1 ? 'One new listing has' : `${count} new listings have`} come to the market:</strong></p>`);

    for (const listing of diff.newListings) {
      parts.push(buildListingHtml(listing, compDescriptions, photosByMls));
    }
  }

  // Status changes with photos
  const underContract = (diff.statusChanges || []).filter((c) =>
    c.status.toLowerCase().includes('option') ||
    c.status.toLowerCase().includes('pending') ||
    c.status.toLowerCase().includes('contingent') ||
    c.status.toLowerCase().includes('kick')
  );

  if (underContract.length) {
    parts.push(`<p><strong>${underContract.length === 1 ? 'One home has' : `${underContract.length} homes have`} gone under contract since our last report:</strong></p>`);

    for (const listing of underContract) {
      const narrative = statusNarratives?.[listing.mlsNumber];
      const desc = narrative || `${listing.address} — ${listing.sqft} sq ft, built ${listing.yearBuilt}, ${listing.lotAcres} acres, ${listing.hasPool ? 'pool' : 'no pool'}. Listed for ${formatPrice(listing.price)}, ${listing.dom} days on market. Was ${listing.previousStatus}, now ${listing.status}.`;
      parts.push(buildListingHtml(listing, { [listing.mlsNumber]: desc }, photosByMls));
    }
  }

  // Feedback
  if (feedback?.length) {
    parts.push(`<p><strong>Showing feedback received:</strong></p>`);
    parts.push('<ul style="margin: 4px 0 16px;">');
    for (const fb of feedback) {
      let line = `<strong>${fb.agent}</strong>`;
      if (fb.brokerage) line += ` (${fb.brokerage})`;
      if (fb.rating) line += ` — rated the home's condition ${fb.rating}`;
      if (fb.comments) line += ` — "${fb.comments}"`;
      if (fb.offerIntent) line += `. ${fb.offerIntent}`;
      parts.push(`<li style="margin-bottom: 4px;">${line}</li>`);
    }
    parts.push('</ul>');
  } else {
    parts.push('<p>No showing feedback was received from agents over the past two weeks.</p>');
  }

  if (data.openHouseNotes) {
    parts.push(`<p>${data.openHouseNotes}</p>`);
  }

  parts.push(`<p>The average days on market for closed homes within the last 90 days is <strong>${closedStats?.avgDomClosed ?? '—'}</strong> with an average sales price of <strong>${closedStats?.avgSoldPrice ? formatPrice(closedStats.avgSoldPrice) : '—'}</strong>.</p>`);

  if (config.agentName) {
    parts.push(`<p>${config.agentName} will reach out to you to discuss this if she hasn't already. Please let us know if you need anything.</p>`);
  }

  parts.push('</div>');

  return parts.join('\n');
}

function buildListingHtml(listing, descriptions, photosByMls) {
  const photos = getListingPhotos(listing.mlsNumber, photosByMls, 4);
  const desc = descriptions?.[listing.mlsNumber] || '';

  let html = '<div style="margin: 16px 0; padding: 16px; background: #f9fafb; border-radius: 8px; border-left: 4px solid #2563eb;">';

  html += `<p style="margin: 0 0 8px;"><strong>${listing.address}</strong> — ${listing.sqft} sq ft, built ${listing.yearBuilt}, ${listing.lotAcres} acres${listing.hasPool ? ', pool' : ', no pool'}. Listed for <strong>${formatPrice(listing.price)}</strong>.</p>`;

  if (desc) {
    html += `<p style="margin: 0 0 10px; color: #374151;">${desc}</p>`;
  }

  if (photos.length) {
    html += '<div style="display: flex; gap: 6px; flex-wrap: wrap;">';
    for (const photo of photos) {
      html += `<img src="${photo}" style="height: 140px; border-radius: 6px; object-fit: cover;" />`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function getListingPhotos(mlsNumber, photosByMls, maxPhotos) {
  const photoData = photosByMls?.[mlsNumber];
  if (!photoData?.photoDir) return [];

  try {
    const dir = photoData.photoDir;
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort()
      .slice(0, maxPhotos);

    return files.map(f => {
      const filePath = path.join(dir, f);
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(f).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    });
  } catch {
    return [];
  }
}

function buildNewListingsPlain(newListings, descriptions) {
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

function buildStatusChangesPlain(statusChanges, narratives) {
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

function buildFeedbackPlain(feedback) {
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
