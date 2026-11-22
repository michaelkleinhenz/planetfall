// Minimal OpenRouter chat-completions client (browser fetch).
// The API key never leaves the browser except in requests to openrouter.ai.

const API = 'https://openrouter.ai/api/v1';

// Preferred models, best first; the first one OpenRouter actually offers is
// used as the default.  Any model id can be entered in the settings.
export const PREFERRED_MODELS = [
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash',
];

export async function listModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`Could not list models (${res.status})`);
  const data = await res.json();
  return (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
}

export async function pickDefaultModel() {
  try {
    const ids = new Set((await listModels()).map((m) => m.id));
    return PREFERRED_MODELS.find((m) => ids.has(m)) || PREFERRED_MODELS[0];
  } catch {
    return PREFERRED_MODELS[0];
  }
}

export async function chat({ apiKey, model, messages, temperature = 0, maxTokens = 400, signal }) {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Planetfall AI',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    const err = new Error(`OpenRouter error ${res.status}${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
