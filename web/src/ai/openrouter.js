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

// Providers that need an explicit cache breakpoint (cache_control). Most other
// providers on OpenRouter (OpenAI, DeepSeek, xAI, ...) cache long, identical
// prompt prefixes automatically, so a stable system prompt is all they need.
const EXPLICIT_CACHE = /^(anthropic|google)\//;

/**
 * Messages may carry `cache: true` to mark a long, unchanging prefix (the system
 * prompt) for prompt caching. Cached input tokens are billed at a fraction of
 * the normal price on subsequent requests.
 */
function prepareMessages(model, messages) {
  return messages.map(({ cache, ...m }) => {
    if (!cache || !EXPLICIT_CACHE.test(model)) return m;
    return { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
  });
}

/** Running token totals for this page session (also logged to the console). */
export const usageStats = { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };

/**
 * One chat completion. Models that reason before answering spend part of the
 * token budget on hidden reasoning; if the answer comes back cut off or empty,
 * the request is repeated once with a much larger budget.
 */
export async function chat(opts) {
  const first = await chatOnce(opts);
  if (first.complete) return first.content;
  const maxTokens = Math.min(8000, Math.max(2000, (opts.maxTokens ?? 1000) * 4));
  console.debug('[openrouter] answer cut off or empty; retrying with', maxTokens, 'tokens');
  const second = await chatOnce({ ...opts, maxTokens });
  return second.content || first.content;
}

async function chatOnce({ apiKey, model, messages, temperature = 0, maxTokens = 1000, signal }) {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Planetfall AI',
    },
    body: JSON.stringify({
      model,
      messages: prepareMessages(model, messages),
      temperature,
      max_tokens: maxTokens,
      usage: { include: true },
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    const err = new Error(`OpenRouter error ${res.status}${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const u = data.usage;
  if (u) {
    usageStats.requests++;
    usageStats.promptTokens += u.prompt_tokens || 0;
    usageStats.cachedTokens += u.prompt_tokens_details?.cached_tokens || 0;
    usageStats.completionTokens += u.completion_tokens || 0;
    usageStats.cost += u.cost || 0;
    console.debug('[openrouter]', model, `prompt ${u.prompt_tokens} (cached ${u.prompt_tokens_details?.cached_tokens || 0}),`,
      `completion ${u.completion_tokens}, cost $${(u.cost || 0).toFixed(5)} | session $${usageStats.cost.toFixed(4)}`);
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  const finish = choice?.finish_reason || choice?.native_finish_reason || '';
  return { content, complete: !!content.trim() && finish !== 'length' && finish !== 'max_tokens' };
}
