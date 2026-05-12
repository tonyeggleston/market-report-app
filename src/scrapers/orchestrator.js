import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getConfig } from '../main/config.js';
import { getDb } from '../db/schema.js';
import { launchMlsBrowser, loginToMls } from './mls-login.js';
import { runSavedSearch, switchToAgentSingleLine, extractCompRows, extractClosedStats } from './mls-search.js';
import { downloadListingPhotos } from './mls-photos.js';
import { extractListingDetail, getOurListingDate } from './mls-details.js';
import { runPriceOnlySearch } from './mls-price-search.js';
import { launchBrokerBayBrowser, loginToBrokerBay } from './bb-login.js';
import { pullShowings } from './bb-showings.js';
import { pullMarketTrends } from './bb-trends.js';
import { buildSubjectProfile } from '../vision/fingerprint.js';
import { analyzeComp } from '../vision/analyze-comp.js';
import { generateCompDescription, generateStatusChangeNarrative } from '../vision/describe.js';
import { computeDiff } from '../report/diff.js';
import { calculateMarketMetrics, accumulateTotalShowings } from '../report/calculate.js';
import { buildEmail } from '../report/email-builder.js';

export async function runReport(listingAddress, onProgress) {
  const config = getConfig();
  if (!config) throw new Error('App not configured. Run setup first.');

  // Sanitize listing address for use as directory name — strip path traversal characters
  const safeName = listingAddress.replace(/[^a-zA-Z0-9 .\-]/g, '').replace(/\s+/g, '-') || 'unnamed';
  const baseDir = path.join(app.getPath('userData'), 'market-report', 'runs');
  const outputDir = path.join(baseDir, safeName);
  // Defense-in-depth: verify the resolved path is still under baseDir
  if (!path.resolve(outputDir).startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error('Invalid listing address — contains disallowed characters.');
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // ═══════════════════════════════════════════
  // PHASE 1–4: MLS
  // ═══════════════════════════════════════════
  const { browser: mlsBrowser, page: mlsPage } = await launchMlsBrowser(config);

  try {
    await loginToMls(mlsPage, config, onProgress);
    await runSavedSearch(mlsPage, listingAddress, onProgress);
    await switchToAgentSingleLine(mlsPage);

    const comps = await extractCompRows(mlsPage, onProgress);

    const ourListing = comps.find(
      (c) => c.address.toLowerCase().includes(listingAddress.toLowerCase())
    );

    let listDate = null;

    // Download photos for every listing
    onProgress('Downloading photos...', `${comps.length} listings to photograph`);
    const photosByMls = {};
    for (const comp of comps) {
      const photoData = await downloadListingPhotos(mlsPage, comp.mlsNumber, outputDir, onProgress);
      photosByMls[comp.mlsNumber] = photoData;
    }

    // Extract details (description + big ticket items) for each listing
    onProgress('Extracting listing details...', 'Reading descriptions');
    const detailsByMls = {};
    for (const comp of comps) {
      const detail = await extractListingDetail(mlsPage, comp.mlsNumber, onProgress);
      detailsByMls[comp.mlsNumber] = detail;
      comp.description = detail.description;
      comp.bigTicketItems = detail.bigTicketItems;
      comp.beds = detail.beds;
      comp.baths = detail.baths;
      if (comp.mlsNumber === ourListing?.mlsNumber && detail.listDate) {
        listDate = detail.listDate;
      }
    }

    // If we didn't get listDate from detail extraction, fetch it explicitly
    if (!listDate && ourListing) {
      listDate = await getOurListingDate(mlsPage, ourListing.mlsNumber);
    }

    // ═══════════════════════════════════════════
    // PHASE 2: Vision AI — subject fingerprint + comp analysis
    // ═══════════════════════════════════════════
    let subjectProfile = null;
    const visionResults = {};

    if (config.openrouterApiKey) {
      if (ourListing && photosByMls[ourListing.mlsNumber]?.photos.length) {
        subjectProfile = await buildSubjectProfile(
          photosByMls[ourListing.mlsNumber].photos,
          config,
          onProgress
        );
      }

      onProgress('Analyzing comp photos...', `${comps.length} listings to analyze`);
      for (const comp of comps) {
        if (comp.mlsNumber === ourListing?.mlsNumber) continue;

        const photos = photosByMls[comp.mlsNumber]?.photos || [];
        const result = await analyzeComp(photos, subjectProfile, comp, config, onProgress);
        visionResults[comp.mlsNumber] = result;
      }
    } else {
      onProgress('Skipping vision analysis...', 'No OpenRouter API key configured');
    }

    // Price range from active comps for BrokerBay workaround
    const activeComps = comps.filter((c) => c.status.toLowerCase().includes('active'));
    const prices = activeComps.map((c) => c.price).filter(Boolean);
    const priceRange = {
      min: prices.length ? Math.min(...prices) : 0,
      max: prices.length ? Math.max(...prices) : 0,
    };

    // Phase 7: MLS price-only re-search to count actives for BrokerBay comparison
    const priceSearchResult = await runPriceOnlySearch(mlsPage, priceRange.min, priceRange.max, onProgress);

    // Extract closed-listing stats (avg DOM closed, avg sold price) from the current results
    const closedStats = await extractClosedStats(mlsPage);

    // ═══════════════════════════════════════════
    // PHASE 5–6: BrokerBay
    // ═══════════════════════════════════════════
    const { browser: bbBrowser, page: bbPage } = await launchBrokerBayBrowser(config);

    let showingData, trendData;
    try {
      await loginToBrokerBay(bbPage, config, onProgress);

      const db = getDb();
      const lastReport = db
        .prepare('SELECT run_date FROM reports WHERE listing_address = ? ORDER BY run_date DESC LIMIT 1')
        .get(listingAddress);

      showingData = await pullShowings(
        bbPage, config, listingAddress, lastReport?.run_date, onProgress
      );

      const neighborhoodName = listingAddress.split(/\d/)[0]?.trim() || listingAddress;
      trendData = await pullMarketTrends(bbPage, config, neighborhoodName, priceRange, onProgress);
    } finally {
      await bbBrowser.close();
    }

    // ═══════════════════════════════════════════
    // PHASE 3: Diff against previous report
    // ═══════════════════════════════════════════
    onProgress('Comparing to previous report...', 'Loading last report');
    const db = getDb();
    const previousReport = db
      .prepare('SELECT data_json FROM reports WHERE listing_address = ? ORDER BY run_date DESC LIMIT 1')
      .get(listingAddress);

    let previousComps = [];
    if (previousReport) {
      try {
        previousComps = JSON.parse(previousReport.data_json).comps || [];
      } catch { /* first run */ }
    }

    const diff = computeDiff(comps, previousComps);
    onProgress('Comparing to previous report...', `${diff.summary.newCount} new, ${diff.summary.statusChangeCount} status changes`);

    // ═══════════════════════════════════════════
    // PHASE 8: Calculate metrics
    // ═══════════════════════════════════════════
    onProgress('Calculating metrics...', 'Showings per listing, DOM stats');
    const metrics = calculateMarketMetrics({
      recentShowings: showingData.recentShowings,
      totalAreaShowings: trendData.totalAreaShowings,
      activeCountPriceSearch: priceSearchResult.activeCount,
      comps,
      ourListing,
    });

    const totalShowings = accumulateTotalShowings(db, listingAddress, metrics.showingCount);

    // ═══════════════════════════════════════════
    // Generate descriptions for new listings + status changes
    // ═══════════════════════════════════════════
    const compDescriptions = {};
    const statusNarratives = {};

    if (config.openrouterApiKey) {
      onProgress('Generating descriptions...', 'Writing listing narratives');

      for (const listing of diff.newListings) {
        const vision = visionResults[listing.mlsNumber];
        if (vision) {
          compDescriptions[listing.mlsNumber] = await generateCompDescription(
            vision, listing, subjectProfile, config
          );
        }
      }

      for (const listing of diff.statusChanges) {
        statusNarratives[listing.mlsNumber] = await generateStatusChangeNarrative(listing, config);
      }
    }

    // ═══════════════════════════════════════════
    // Build result package (BEFORE email — comp review happens here)
    // ═══════════════════════════════════════════
    const reportData = {
      comps,
      subjectProfile,
      visionResults,
      compDescriptions,
      statusNarratives,
      diff,
      metrics,
      showingData: {
        recentShowings: showingData.recentShowings,
        teamShowings: showingData.teamShowings,
        totalShowingsSinceLive: showingData.totalShowingsSinceLive,
        feedback: showingData.feedback,
      },
      trendData,
      priceSearchResult,
      closedStats,
      listDate,
      totalShowings,
      ourListing,
      photosByMls: Object.fromEntries(
        Object.entries(photosByMls).map(([mls, data]) => [
          mls,
          { photoCount: data.photos.length, photoDir: data.photoDir },
        ])
      ),
    };

    onProgress('Done!', 'Ready for review');

    return {
      reportData,
      outputDir,
      needsReview: true,
    };
  } finally {
    await mlsBrowser.close().catch(() => {});
  }
}

export async function finalizeReport(listingAddress, reportData, compOverrides, descriptionEdits, config) {
  const db = getDb();

  for (const [mlsNumber, include] of Object.entries(compOverrides || {})) {
    const vision = reportData.visionResults[mlsNumber];
    if (vision) {
      vision.includeRecommendation = include;
      vision.userOverride = true;
    }
  }

  for (const [mlsNumber, editedDesc] of Object.entries(descriptionEdits || {})) {
    reportData.compDescriptions[mlsNumber] = editedDesc;
  }

  const selectedMlsNumbers = reportData.comps
    .filter((c) => {
      const vision = reportData.visionResults[c.mlsNumber];
      return vision?.includeRecommendation ?? true;
    })
    .map((c) => c.mlsNumber);

  const email = buildEmail(config, {
    metrics: reportData.metrics,
    totalShowings: reportData.totalShowings,
    listDate: reportData.listDate,
    diff: reportData.diff,
    compDescriptions: reportData.compDescriptions,
    statusNarratives: reportData.statusNarratives,
    feedback: reportData.showingData.feedback,
    closedStats: reportData.closedStats || {},
    openHouseNotes: '',
    photosByMls: reportData.photosByMls,
  });

  const result = db.prepare(
    'INSERT INTO reports (listing_address, data_json, email_body, cma_pdf_path, subject_profile_json) VALUES (?, ?, ?, ?, ?)'
  ).run(
    listingAddress,
    JSON.stringify(reportData),
    email.plainText,
    reportData.cmaPdfPath || null,
    reportData.subjectProfile ? JSON.stringify(reportData.subjectProfile) : null
  );

  const reportId = result.lastInsertRowid;

  for (const comp of reportData.comps) {
    const compResult = db.prepare(`
      INSERT INTO comps (report_id, mls_number, address, sqft, year_built, lot_acres, has_pool, price, status, days_on_market, flag, description, big_ticket_items, included, user_override)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId, comp.mlsNumber, comp.address, comp.sqft, comp.yearBuilt,
      comp.lotAcres, comp.hasPool ? 1 : 0, comp.price, comp.status, comp.dom,
      comp.flag, comp.description, JSON.stringify(comp.bigTicketItems || []),
      selectedMlsNumbers.includes(comp.mlsNumber) ? 1 : 0,
      (compOverrides?.[comp.mlsNumber] !== undefined) ? 1 : 0
    );

    const vision = reportData.visionResults[comp.mlsNumber];
    if (vision) {
      db.prepare(`
        INSERT INTO comp_vision (comp_id, report_id, mls_number, photo_count, analysis_json, match_score, include_recommendation, override_include, overall_update_level, red_flags, reasoning, generated_description, edited_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        compResult.lastInsertRowid, reportId, comp.mlsNumber,
        vision.photoCount, JSON.stringify(vision.analysis),
        vision.matchScore, vision.includeRecommendation ? 1 : 0,
        vision.userOverride ? 1 : 0,
        vision.overallUpdateLevel, JSON.stringify(vision.redFlags || []),
        vision.reasoning,
        reportData.compDescriptions[comp.mlsNumber] || null,
        descriptionEdits?.[comp.mlsNumber] || null
      );
    }
  }

  for (const showing of reportData.showingData.recentShowings) {
    db.prepare(`
      INSERT INTO showings (report_id, showing_date, showing_time, agent_name, brokerage, status, is_team_member)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reportId, showing.date, showing.time || '', showing.agentName, showing.brokerage, showing.status, 0);
  }

  for (const showing of reportData.showingData.teamShowings) {
    db.prepare(`
      INSERT INTO showings (report_id, showing_date, showing_time, agent_name, brokerage, status, is_team_member, is_open_house)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reportId, showing.date, showing.time || '', showing.agentName, showing.brokerage, showing.status, 1, 1);
  }

  for (const fb of reportData.showingData.feedback) {
    db.prepare(`
      UPDATE showings SET feedback_rating = ?, feedback_comments = ?, feedback_offer_intent = ?
      WHERE report_id = ? AND agent_name = ?
    `).run(fb.rating, fb.comments, fb.offerIntent, reportId, fb.agent);
  }

  db.prepare(`
    INSERT INTO market_stats (report_id, total_area_showings, active_listing_count, active_count_price_search, showings_per_listing, avg_dom_active, max_dom_active, min_dom_active, price_range_min, price_range_max, our_dom, list_date, total_showings_since_live)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportId,
    reportData.trendData.totalAreaShowings,
    reportData.metrics.activeCount,
    reportData.priceSearchResult.activeCount,
    parseFloat(reportData.metrics.showingsPerListing),
    reportData.metrics.avgDomActive,
    reportData.metrics.maxDomActive,
    reportData.metrics.minDomActive,
    reportData.metrics.priceRange.min,
    reportData.metrics.priceRange.max,
    reportData.metrics.ourDom,
    reportData.listDate,
    reportData.totalShowings
  );

  return { emailBody: email.plainText, emailHtml: email.html, reportId };
}
