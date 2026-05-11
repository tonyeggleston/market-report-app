import https from 'node:https';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function callVisionModel(content, config) {
  const model = config.openrouterModel || 'google/gemini-2.5-flash';
  const apiKey = config.openrouterApiKey;

  if (!apiKey) {
    throw new Error('OpenRouter API key not configured. Go to Settings to add it.');
  }

  const body = JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
  });

  const response = await postJson(OPENROUTER_API_URL, body, apiKey);
  return response.choices?.[0]?.message?.content || '';
}

export async function callTextModel(prompt, config) {
  const model = config.openrouterTextModel || config.openrouterModel || 'google/gemini-2.5-flash';
  const apiKey = config.openrouterApiKey;

  if (!apiKey) {
    throw new Error('OpenRouter API key not configured. Go to Settings to add it.');
  }

  const body = JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  });

  const response = await postJson(OPENROUTER_API_URL, body, apiKey);
  return response.choices?.[0]?.message?.content || '';
}

function postJson(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://market-report-app.local',
        'X-Title': 'Market Report Generator',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`OpenRouter error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse OpenRouter response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('OpenRouter request timed out (120s)'));
    });

    req.write(body);
    req.end();
  });
}
