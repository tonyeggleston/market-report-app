// AI proxy — keeps the OpenRouter key OFF the client.
//
// The desktop app used to call OpenRouter directly with a key bundled in the
// (unencrypted) app, so anyone who obtained a build could extract the key and
// spend Tony's money with no ceiling. Now the key lives ONLY here (Vercel env
// OPENROUTER_API_KEY) and the client asks this endpoint to make the call.
//
// Access is gated by the Ed25519-signed license token: only a client that
// recently validated an ACTIVE subscription holds a valid token, so a leaked
// build (no token) can't use the proxy, and a canceled account loses AI within
// the token's 72h lifetime. Cost per call is bounded server-side by a model
// allowlist + a max_tokens cap, so even a valid token can't invoke an
// expensive model or an unbounded generation.
//
// Teams on their OWN OpenRouter key (e.g. the Davis Team's own-billing setup)
// never hit this endpoint — the client calls OpenRouter directly for them.

import { verifyLicenseToken } from './_license-token.js';
import { rateLimited, allow } from './_ratelimit.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Only the cheap models the app actually uses. A valid token can't be turned
// into a bill for GPT-4-class inference.
const MODEL_ALLOWLIST = new Set([
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
]);
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const MAX_TOKENS_CAP = { vision: 4096, text: 1024 };

// Bound what a valid token can spend on INPUT (output is capped via
// max_tokens). Sized to the real clients: describe.js sends few-KB text
// prompts; fingerprint.js sends one text part + up to 25 data-URI image parts.
// Data-URI images are bounded by Vercel's ~4.5MB body cap and tokenize cheaply.
const MAX_TEXT_CHARS = 64_000;
const MAX_PARTS = 30;

function validContent(mode, content) {
  if (typeof content === 'string') return content.length > 0 && content.length <= MAX_TEXT_CHARS;
  if (mode !== 'vision' || !Array.isArray(content) || content.length === 0 || content.length > MAX_PARTS) return false;
  let textChars = 0;
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      textChars += part.text.length;
    } else if (!(part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/'))) {
      return false;
    }
  }
  return textChars <= MAX_TEXT_CHARS;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Per-IP here is the cheap pre-verification hammer guard; the per-key
  // ceiling is enforced below on the token's VERIFIED licenseKey (the AI body
  // carries `token`, not `licenseKey`, so rateLimited's per-key branch never
  // engages on this route).
  if (rateLimited(req, res, { tag: 'ai', ipLimit: 240, windowMs: 60_000 })) return;

  const { token, mode, content, model, max_tokens } = req.body || {};

  const payload = verifyLicenseToken(token, Date.now());
  if (!payload) {
    return res.status(401).json({ error: 'AI access requires a valid, active license.' });
  }
  // AI calls are frequent during a run (~one per comp), so the ceiling is
  // generous — it exists to stop a scripted drain on a stolen token.
  if (!allow(`ai:key:${payload.licenseKey}`, { limit: 240, windowMs: 60_000 })) {
    return res.status(429).json({ error: 'Too many requests for this license. Slow down and try again shortly.' });
  }
  if (mode !== 'vision' && mode !== 'text') {
    return res.status(400).json({ error: 'mode must be "vision" or "text"' });
  }
  if (!validContent(mode, content)) return res.status(400).json({ error: 'Invalid content' });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not configured');
    return res.status(503).json({ error: 'AI is temporarily unavailable.' });
  }

  const chosenModel = MODEL_ALLOWLIST.has(model) ? model : DEFAULT_MODEL;
  const cap = MAX_TOKENS_CAP[mode];
  const maxTokens = Math.max(1, Math.min(Number(max_tokens) || cap, cap));

  const body = JSON.stringify({
    model: chosenModel,
    messages: [{ role: 'user', content }],
    max_tokens: maxTokens,
    temperature: mode === 'vision' ? 0.1 : 0.3,
  });

  try {
    const orRes = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://marketpulse.commandmodule.com',
        'X-Title': 'MarketPulse',
      },
      body,
    });
    const data = await orRes.json();
    if (!orRes.ok || data.error) {
      const msg = data.error?.message || `OpenRouter error ${orRes.status}`;
      // Don't leak provider internals to the client; log for the operator.
      console.error('OpenRouter proxy error:', msg);
      return res.status(502).json({ error: 'AI request failed.' });
    }
    return res.json({ content: data.choices?.[0]?.message?.content || '' });
  } catch (err) {
    console.error('AI proxy exception:', err.message);
    return res.status(502).json({ error: 'AI request failed.' });
  }
}
