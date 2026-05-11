import { callTextModel } from './openrouter.js';

export async function generateCompDescription(compAnalysis, compData, subjectProfile, config) {
  const bigTicketStr = (compData.bigTicketItems || []).length
    ? `Big-ticket items from MLS description: ${compData.bigTicketItems.join(', ')}.`
    : 'No major big-ticket items noted in MLS description.';

  const analysisStr = typeof compAnalysis.analysis === 'string'
    ? compAnalysis.analysis
    : JSON.stringify(compAnalysis.analysis, null, 2);

  const prompt = `You are writing a biweekly seller market report email for a real estate team. Write a 1-3 sentence description of a comparable listing, comparing it to the seller's home.

STYLE GUIDE: Write exactly like a real estate coordinator talking to a seller. Conversational, specific, direct. Examples of the voice:
- "This home is mostly updated throughout aside from bathrooms, and it has a new roof."
- "Light, bright, whites and grays with wood look laminate flooring. Kitchen is updated with painted cabinets and stainless steel appliances."
- "Semi-updated with a white fireplace and wood flooring. The kitchen is updated whites and grays, but some rooms have clashing wood species — cherry floors with oak cabinets."
- "However, it is not quite as updated as our home."

COMP LISTING:
- Address: ${compData.address}
- ${compData.sqft} sq ft, built ${compData.yearBuilt}, ${compData.lotAcres} acres
- Pool: ${compData.hasPool ? 'Yes' : 'No'}
- Listed at $${compData.price}
- ${compData.dom} days on market
${bigTicketStr}

VISION ANALYSIS OF COMP PHOTOS:
${analysisStr}

INCLUDE/EXCLUDE: ${compAnalysis.includeRecommendation ? 'INCLUDED as comp' : 'EXCLUDED — not comparable'}
REASONING: ${compAnalysis.reasoning}

Write the description now. 1-3 sentences only. No bullet points. Match the voice above exactly. Mention specific visual details from the analysis (flooring type, cabinet color, bathroom condition, pool, patio, any red flags). If there are big-ticket items, mention them.`;

  const response = await callTextModel(prompt, config);
  return response.trim();
}

export async function generateStatusChangeNarrative(compData, config) {
  const prompt = `You are writing a biweekly seller market report email for a real estate team. Write a brief narrative about a comparable listing that changed status (went under contract, price dropped, etc).

STYLE GUIDE: Conversational, factual, brief. Examples:
- "8 Greenbrier Court, first listed in September for $5.62, slowly dropped to $5.20 before coming off market in December. Relisted in July at $4.99, currently listed for $4.79. This one is now under contract after 58 days on market."
- "205 Pebble Beach Drive with 2529 sq ft, built in 1987 on .266 acres without a pool. Listed for $6.45 and was on market for 116 days before going under contract."

LISTING DATA:
- Address: ${compData.address}
- ${compData.sqft} sq ft, built ${compData.yearBuilt}, ${compData.lotAcres} acres
- Pool: ${compData.hasPool ? 'Yes' : 'No'}
- Price: $${compData.price}
- Days on market: ${compData.dom}
- Previous status: ${compData.previousStatus || 'Active'}
- Current status: ${compData.status}
- Price history: ${compData.priceHistory || 'Not available'}

Write the narrative now. 1-3 sentences. Match the voice above.`;

  const response = await callTextModel(prompt, config);
  return response.trim();
}
