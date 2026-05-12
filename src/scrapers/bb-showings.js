export async function pullShowings(page, config, listingAddress, lastReportDate, onProgress) {
  onProgress('Pulling showings...', `Searching for "${listingAddress}"`);

  const searchInput = await page.$(
    'input[placeholder*="Search"], input[type="search"], input[name*="search"]'
  );
  if (searchInput) {
    await searchInput.fill(listingAddress);
    await page.waitForTimeout(2000);
  }

  const listingLink = await page.$(
    `a:has-text("${listingAddress}"), div:has-text("${listingAddress}") a, tr:has-text("${listingAddress}")`
  );
  if (listingLink) {
    await listingLink.click();
    await page.waitForLoadState('networkidle');
  }

  const showingsTab = await page.$(
    'a:has-text("Showings"), button:has-text("Showings"), [data-tab="showings"], li:has-text("Showings")'
  );
  if (showingsTab) {
    await showingsTab.click();
    await page.waitForLoadState('networkidle');
  }

  await page.waitForTimeout(1500);

  const teamBrokerage = (config.teamBrokerage || '').toLowerCase();
  const teamMembers = (config.teamMembers || []).map((n) => n.toLowerCase().trim());

  const rawShowings = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      'table tbody tr, [class*="showing-row"], [class*="ShowingRow"], [class*="showing-item"], [class*="showingItem"]'
    );
    const results = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td, [class*="cell"], span, div');
      const text = row.textContent || '';

      const hasFeedbackIcon = row.querySelector(
        '[class*="feedback"] svg, [class*="check"], .fa-check, [class*="Feedback"]'
      );

      results.push({
        rawText: text.trim(),
        date: cells[0]?.textContent?.trim() || '',
        time: cells[1]?.textContent?.trim() || '',
        agentName: cells[2]?.textContent?.trim() || cells[1]?.textContent?.trim() || '',
        brokerage: cells[3]?.textContent?.trim() || cells[2]?.textContent?.trim() || '',
        status: (() => {
          for (const cell of cells) {
            const t = (cell.textContent || '').toLowerCase();
            if (t.includes('confirm')) return 'confirmed';
            if (t.includes('denied') || t.includes('deny')) return 'denied';
            if (t.includes('expired') || t.includes('time passed')) return 'expired';
            if (t.includes('cancel')) return 'cancelled';
          }
          return 'unknown';
        })(),
        hasFeedback: !!hasFeedbackIcon || text.includes('✓'),
      });
    }
    return results;
  });

  const cutoffDate = lastReportDate ? new Date(lastReportDate) : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d;
  })();

  const showings = rawShowings.map((s) => {
    const isTeam =
      (teamBrokerage && s.brokerage.toLowerCase().includes(teamBrokerage)) ||
      teamMembers.some((name) => s.agentName.toLowerCase().includes(name));

    // Parse the showing date for cutoff filtering
    const showingDate = s.date ? new Date(s.date) : null;
    const isRecent = showingDate ? showingDate >= cutoffDate : true; // include if unparseable

    return {
      ...s,
      isTeam,
      isConfirmed: s.status === 'confirmed',
      isRecent,
    };
  });

  const recentConfirmed = showings.filter((s) => s.isConfirmed && !s.isTeam && s.isRecent);
  const recentTeam = showings.filter((s) => s.isTeam && s.isConfirmed && s.isRecent);
  const allConfirmed = showings.filter((s) => s.isConfirmed);
  const totalNonTeam = allConfirmed.filter((s) => !s.isTeam).length;
  const denied = showings.filter((s) => s.status === 'denied');

  onProgress('Pulling showings...', `${recentConfirmed.length} confirmed (${recentTeam.length} team, ${denied.length} denied)`);

  const feedback = [];
  for (const showing of showings.filter((s) => s.hasFeedback)) {
    const feedbackData = await extractFeedback(page, showing);
    if (feedbackData) {
      feedback.push({ agent: showing.agentName, brokerage: showing.brokerage, ...feedbackData });
    }
  }

  return {
    recentShowings: recentConfirmed,
    teamShowings: recentTeam,
    totalShowingsSinceLive: totalNonTeam,
    deniedShowings: denied,
    feedback,
    allRaw: showings,
  };
}

async function extractFeedback(page, showing) {
  try {
    const feedbackData = await page.evaluate((agentName) => {
      const feedbackEls = document.querySelectorAll(
        '[class*="feedback"], [class*="Feedback"], [class*="review"], tr[class*="feedback"]'
      );

      for (const el of feedbackEls) {
        if (el.textContent.includes(agentName)) {
          const ratingEl = el.querySelector('[class*="rating"], [class*="star"], [class*="score"]');
          const commentEl = el.querySelector('[class*="comment"], [class*="note"], [class*="remark"], textarea, p');
          const offerEl = el.querySelector('[class*="offer"], [class*="interest"]');

          const ratingText = ratingEl?.textContent?.trim() || '';
          const ratingMatch = ratingText.match(/(\d)\s*(?:out\s*of|\/)\s*(\d)/);

          return {
            rating: ratingMatch ? `${ratingMatch[1]} out of ${ratingMatch[2]}` : ratingText || null,
            comments: commentEl?.textContent?.trim() || null,
            offerIntent: offerEl?.textContent?.trim() || (el.textContent.toLowerCase().includes('offer') ? 'May bring offer' : null),
          };
        }
      }
      return null;
    }, showing.agentName);

    return feedbackData;
  } catch {
    return null;
  }
}
