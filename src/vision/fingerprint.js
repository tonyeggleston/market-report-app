import fs from 'node:fs';
import path from 'node:path';
import { callVisionModel } from './openrouter.js';

export async function buildSubjectProfile(photos, config, onProgress) {
  onProgress('Analyzing subject property...', `${photos.length} photos to process`);

  const imagePayloads = photos.slice(0, 25).map((photo) => {
    const data = fs.readFileSync(photo.filepath);
    const base64 = data.toString('base64');
    const ext = path.extname(photo.filepath).replace('.', '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
  });

  const prompt = `You are a real estate listing photo analyst. I'm showing you ALL the photos from a residential listing (the "subject property"). Analyze every room and outdoor area visible.

Return a JSON object with this exact structure — no markdown, no explanation, just the JSON:

{
  "overall_style": "modern" | "transitional" | "traditional" | "dated" | "mixed",
  "color_palette": {
    "dominant_colors": ["white", "gray", etc],
    "modern_whites_grays": true/false,
    "description": "light bright whites and grays throughout" or similar
  },
  "kitchen": {
    "update_level": "modern" | "semi-updated" | "dated" | "not visible",
    "cabinet_color": "white" | "gray" | "wood" | "painted other" | "not visible",
    "cabinet_style": "shaker" | "flat panel" | "raised panel" | "not visible",
    "countertops": "granite" | "quartz" | "marble" | "laminate" | "butcher block" | "not visible",
    "appliances": "stainless steel" | "black" | "white" | "mixed" | "not visible",
    "backsplash": true/false,
    "notes": ""
  },
  "bathrooms": [
    {
      "update_level": "modern" | "semi-updated" | "dated",
      "standalone_tub": true/false,
      "tiled_shower": true/false,
      "palette": "whites and grays" | "earth tones" | "colorful" | "dated",
      "vanity_style": "modern" | "traditional" | "dated",
      "notes": ""
    }
  ],
  "flooring": {
    "primary_type": "wood look laminate" | "hardwood" | "carpet" | "tile" | "mixed",
    "consistent_throughout": true/false,
    "notes": ""
  },
  "fireplace": {
    "present": true/false,
    "painted_white": true/false,
    "surround_style": "modern" | "stone" | "brick" | "tile" | "not visible",
    "notes": ""
  },
  "special_features": ["plantation shutters", "exposed beams", "thick baseboards", "crown molding", "chandelier", etc],
  "outdoor": {
    "covered_patio": true/false,
    "patio_type": "covered" | "pergola" | "open" | "screened" | "none visible",
    "pool": true/false,
    "backyard_size": "large" | "medium" | "small" | "none" | "not visible",
    "notes": ""
  },
  "overall_update_level": "fully updated" | "mostly updated" | "semi-updated" | "dated",
  "style_summary": "A 1-2 sentence description of this home's overall style and condition, as a real estate professional would describe it"
}`;

  const content = [
    { type: 'text', text: prompt },
    ...imagePayloads,
  ];

  const response = await callVisionModel(content, config);

  let profile;
  try {
    const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    profile = JSON.parse(jsonStr);
  } catch {
    profile = { raw: response, parseError: true };
  }

  onProgress('Analyzing subject property...', 'Style profile complete');
  return profile;
}
