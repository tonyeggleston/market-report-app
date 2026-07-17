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
import { rateLimited } from './_ratelimit.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Only the cheap models the app actually uses. A valid token can't be turned
// into a bill for GPT-4-class inference.
const MODEL_ALLOWLIST = new Set([
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
]);
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const MAX_TOKENS_CAP = { vision: 4096, text: 1024 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // AI calls are frequent during a run (~one per comp), so the per-key ceiling
  // is generous; the IP ceiling blunts a scripted drain attempt.
  if (rateLimited(req, res, { tag: 'ai', ipLimit: 240, keyLimit: 240, windowMs: 60_000 })) return;

  const { token, mode, content, model, max_tokens } = req.body || {};

  const payload = verifyLicenseToken(token, Date.now());
  if (!payload) {
    return res.status(401).json({ error: 'AI access requires a valid, active license.' });
  }
  if (mode !== 'vision' && mode !== 'text') {
    return res.status(400).json({ error: 'mode must be "vision" or "text"' });
  }
  if (content == null) return res.status(400).json({ error: 'Missing content' });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not configured');
    return res.status(503).json({ error: 'AI is temporarily unavailable.' });
  }

  const chosenModel = MODEL_ALLOWLIST.has(model) ? model : DEFAULT_MODEL;
  const cap = MAX_TOKENS_CAP[mode];
  const maxTokens = Math.min(Number(max_tokens) || cap, cap);

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
