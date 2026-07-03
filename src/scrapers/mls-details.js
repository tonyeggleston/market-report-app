import { sel } from './selectors.js';

export async function extractListingDetail(page, mlsNumber, onProgress) {
  onProgress('Extracting listing details...', mlsNumber);

  const mlsLink = await page.$(
    sel('mls.listingLink', `a:has-text("${mlsNumber}"), td:has-text("${mlsNumber}") a, a[href*="${mlsNumber}"]`)
  );

  if (!mlsLink) {
    return { mlsNumber, description: '', listDate: null, bigTicketItems: [] };
  }

  const [newPage] = await Promise.all([
    page.context().waitForEvent('page').catch(() => null),
    mlsLink.click({ modifiers: ['Control'] }).catch(() => mlsLink.click()),
  ]);

  const detailPage = newPage || page;
  await detailPage.waitForLoadState('domcontentloaded').catch(() => {});

  const descSel = sel('mls.detail.description', '[class*="remarks"], [class*="Remarks"], [class*="description"], [class*="Description"], [id*="remarks"], td:has(> span:has-text("Remarks")) + td');
  const detail = await detailPage.evaluate((descriptionSelector) => {
    const text = document.body.innerText;

    const descEl = document.querySelector(descriptionSelector);
    const description = descEl?.textContent?.trim() || '';

    const ldMatch = text.match(/(?:list\s*date|LD|listing\s*date)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    const listDate = ldMatch ? ldMatch[1] : null;

    const bedMatch = text.match(/(\d+)\s*(?:bed|BR)/i);
    const bathMatch = text.match(/([\d.]+)\s*(?:bath|BA)/i);

    return {
      description,
      listDate,
      beds: bedMatch ? parseInt(bedMatch[1]) : null,
      baths: bathMatch ? parseFloat(bathMatch[1]) : null,
    };
  }, descSel);

  const bigTicketItems = parseBigTicketItems(detail.description);

  if (newPage && newPage !== page) {
    await newPage.close();
  }

  return {
    mlsNumber,
    description: detail.description,
    listDate: detail.listDate,
    beds: detail.beds,
    baths: detail.baths,
    bigTicketItems,
  };
}

function parseBigTicketItems(description) {
  if (!description) return [];

  const items = [];

  const patterns = [
    { regex: /new\s+roof|roof\s+(?:replaced|installed|new)|recently\s+(?:installed|replaced)\s+roof/i, label: 'new roof' },
    { regex: /new\s+hvac|hvac\s+(?:replaced|installed|new)|new\s+(?:ac|a\/c|air\s*condition)/i, label: 'new HVAC' },
    { regex: /new\s+windows|windows\s+(?:replaced|installed|new)/i, label: 'new windows' },
    { regex: /new\s+plumbing|plumbing\s+(?:replaced|updated|new)|re-?plumbed/i, label: 'new plumbing' },
    { regex: /new\s+(?:water\s+)?heater|water\s+heater\s+(?:replaced|new)/i, label: 'new water heater' },
    { regex: /new\s+foundation|foundation\s+(?:repaired|replaced|work)/i, label: 'foundation work' },
    { regex: /new\s+(?:electrical|wiring)|(?:electrical|wiring)\s+(?:updated|replaced|new)/i, label: 'updated electrical' },
    { regex: /new\s+(?:sewer|septic)|(?:sewer|septic)\s+(?:replaced|new)/i, label: 'new sewer/septic' },
    { regex: /pool\s+(?:resurfaced|replastered|new|updated)|new\s+pool/i, label: 'pool work' },
    { regex: /new\s+fence|fence\s+(?:replaced|new)/i, label: 'new fence' },
  ];

  for (const { regex, label } of patterns) {
    if (regex.test(description)) {
      items.push(label);
    }
  }

  return items;
}

export async function getOurListingDate(page, mlsNumber) {
  const mlsLink = await page.$(
    sel('mls.detail.listingLinkNav', `a:has-text("${mlsNumber}"), td:has-text("${mlsNumber}") a`)
  );

  if (!mlsLink) return null;

  await mlsLink.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const listDate = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/(?:list\s*date|LD|listing\s*date)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    return match ? match[1] : null;
  });

  await page.goBack();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  return listDate;
}
