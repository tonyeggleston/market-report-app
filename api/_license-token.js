// Ed25519-signed license tokens for offline grace.
//
// The offline path in the desktop app must NOT trust a plaintext local file
// (that file is owned by the user and trivially forged). Instead the server
// signs a short-lived token here; the client verifies the signature against a
// bundled PUBLIC key and honors it only until an absolute, server-set expiry.
// Forgery is impossible without the private key, which lives only in Vercel.
//
// Private key: env LICENSE_SIGNING_KEY (PKCS#8 PEM, Ed25519). If unset, signing
// is skipped and validate simply returns no token — the online path is
// unaffected; offline grace just isn't available until the key is configured.

import crypto from 'node:crypto';

// How long a signed token remains valid for offline use. Reports need internet
// anyway (MLS/showings/AI), so this only covers the license server itself being
// briefly unreachable — it does not need to be long.
export const TOKEN_GRACE_MS = 72 * 60 * 60 * 1000; // 72 hours

function loadPrivateKey() {
  const pem = process.env.LICENSE_SIGNING_KEY;
  if (!pem) return null;
  try {
    // Allow the key to be stored with literal \n (common in env UIs).
    const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
    return crypto.createPrivateKey(normalized);
  } catch (err) {
    console.error('LICENSE_SIGNING_KEY is set but unparseable:', err.message);
    return null;
  }
}

// Derive the public key from the configured private key (same key material) so
// the server can verify its own tokens on the AI-proxy path without a Stripe
// round-trip. Cached across warm invocations.
let cachedPublicKey;
function loadPublicKey() {
  if (cachedPublicKey !== undefined) return cachedPublicKey;
  const priv = loadPrivateKey();
  cachedPublicKey = priv ? crypto.createPublicKey(priv) : null;
  return cachedPublicKey;
}

// Verify a signed token server-side. Returns the decoded payload if the
// signature is valid and it hasn't expired, else null. Used to authenticate
// the AI proxy: only a client holding a token this server recently issued to an
// active subscription can call it.
export function verifyLicenseToken(token, nowMs) {
  if (!token || !token.payload || !token.sig) return null;
  const pub = loadPublicKey();
  if (!pub) return null;
  try {
    const ok = crypto.verify(null, Buffer.from(token.payload), pub, Buffer.from(token.sig, 'base64url'));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(token.payload, 'base64url').toString('utf8'));
    if (typeof payload.validUntil !== 'number' || nowMs > payload.validUntil) return null;
    return payload;
  } catch {
    return null;
  }
}

// Build a signed token for a validated, active account. Returns null when no
// signing key is configured (caller just omits the token).
export function signLicenseToken(fields, nowMs) {
  const key = loadPrivateKey();
  if (!key) return null;

  const payload = {
    v: 1,
    customerId: fields.customerId,
    licenseKey: fields.licenseKey,
    plan: fields.plan,
    reportsIncluded: fields.reportsIncluded,
    overageRate: fields.overageRate,
    issuedAt: nowMs,
    validUntil: nowMs + TOKEN_GRACE_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(payloadB64), key).toString('base64url');
  return { payload: payloadB64, sig };
}
