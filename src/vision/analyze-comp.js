import fs from 'node:fs';
import path from 'node:path';
import { callVisionModel } from './openrouter.js';

export async function analyzeComp(compPhotos, subjectProfile, compData, config, onProgress) {
  const label = compData.address || compData.mlsNumber;
  onProgress('Analyzing comp photos...', `${label}: ${compPhotos.length} photos`);

  if (!compPhotos.length) {
    return {
      mlsNumber: compData.mlsNumber,
      address: compData.address,
      photoCount: 0,
      analysis: null,
      matchScore: 0,
      includeRecommendation: false,
      reasoning: 'No photos available for analysis.',
    };
  }

  const imagePayloads = compPhotos.slice(0, 20).map((photo) => {
    const data = fs.readFileSync(photo.filepath);
    const base64 = data.toString('base64');
    const ext = path.extname(photo.filepath).replace('.', '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
  });

  const subjectSummary = typeof subjectProfile === 'string'
    ? subjectProfile
    : JSON.stringify(subjectProfile, null, 2);

  const prompt = `You are an expert real estate comp analyst. You're comparing a potential comparable listing's photos against a SUBJECT PROPERTY style profile.

SUBJECT PROPERTY PROFILE:
${subjectSummary}

COMP LISTING DATA:
- Address: ${compData.address}
- Square feet: ${compData.sqft}
- Year built: ${compData.yearBuilt}
- Lot: ${compData.lotAcres} acres
- Pool: ${compData.hasPool ? 'Yes' : 'No'}
- Price: $${compData.price}
- Days on market: ${compData.dom}
- MLS description excerpt: ${(compData.description || '').slice(0, 500)}

Analyze the comp listing's photos and compare to the subject property. Focus on:
1. Kitchen — cabinet color/style, countertops, appliances, update level vs subject
2. Each bathroom — update level, fixtures, palette, modern or dated vs subject
3. Flooring — type, consistency, match to subject's style
4. Color palette — whites/grays vs dated tones, match to subject
5. Fireplace — painted/updated or original
6. Outdoor — patio, pool, backyard vs subject
7. Red flags — clashing materials (e.g. cherry floors + oak cabinets + wood blinds), seashell sinks, strange patterns, dated fixtures, inconsistent styles

Return JSON only — no markdown, no explanation:

{
  "kitchen": {
    "update_level": "modern" | "semi-updated" | "dated" | "not visible",
    "white_cabinets": true/false,
    "stainless_appliances": true/false,
    "comparison_to_subject": "comparable" | "slightly less updated" | "significantly less updated" | "more updated",
    "notes": ""
  },
  "bathrooms": [
    {
      "update_level": "modern" | "semi-updated" | "dated",
      "standalone_tub": true/false,
      "tiled_shower": true/false,
      "palette": "whites and grays" | "earth tones" | "colorful" | "dated",
      "comparison_to_subject": "comparable" | "less updated" | "more updated",
      "notes": ""
    }
  ],
  "flooring": {
    "type": "wood look laminate" | "hardwood" | "carpet" | "tile" | "mixed",
    "consistent": true/false,
    "matches_subject": true/false,
    "notes": ""
  },
  "palette": {
    "dominant_colors": [],
    "modern_whites_grays": true/false,
    "matches_subject": true/false
  },
  "fireplace": {
    "present": true/false,
    "painted_white": true/false,
    "updated": true/false
  },
  "outdoor": {
    "covered_patio": true/false,
    "pool": true/false,
    "backyard_size": "large" | "medium" | "small" | "none",
    "comparison_to_subject": "comparable" | "less" | "more"
  },
  "red_flags": [],
  "overall_match_score": 1-10,
  "overall_update_level": "fully updated" | "mostly updated" | "semi-updated" | "dated",
  "include_recommendation": true/false,
  "reasoning": "2-3 sentence explanation of why include or exclude, referencing specific visual evidence"
}`;

  const content = [
    { type: 'text', text: prompt },
    ...imagePayloads,
  ];

  const response = await callVisionModel(content, config);

  let analysis;
  try {
    const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    analysis = JSON.parse(jsonStr);
  } catch {
    analysis = { raw: response, parseError: true };
  }

  return {
    mlsNumber: compData.mlsNumber,
    address: compData.address,
    photoCount: compPhotos.length,
    analysis,
    matchScore: analysis.overall_match_score || 0,
    includeRecommendation: analysis.include_recommendation ?? false,
    reasoning: analysis.reasoning || 'Could not determine.',
    overallUpdateLevel: analysis.overall_update_level || 'unknown',
    redFlags: analysis.red_flags || [],
  };
}
