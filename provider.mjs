/**
 * LLM provider — routes to the correct API based on provider config.
 *
 * Supported providers are registered below.  Each entry declares its
 * default baseURL, model, and any provider-specific options (e.g. thinking).
 *
 * @param {object} provider
 * @param {string} provider.apiKey
 * @param {string} provider.type        - provider name (e.g. 'deepseek')
 * @param {string} [provider.model]     - falls back to REGISTRY default
 * @param {string} [provider.baseURL]   - falls back to REGISTRY default
 * @param {object} [provider.thinking]  - provider-specific reasoning config
 * @param {object} opts
 * @param {object[]} opts.messages
 * @param {object[]} [opts.tools]
 * @param {(token: string) => void} [opts.onToken]
 * @param {(reasoning: string) => void} [opts.onReasoning]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ content: string|null, toolCalls: object[], usage: object|null, reasoning: string|null }>}
 */

// ─── Provider registry — single source of truth for per-provider defaults ──────

const REGISTRY = {
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    thinking: { type: 'enabled' },
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
};

/** Return a *copy* of the default config for a named provider, or null. */
export function getProviderDefaults(name) {
  const entry = REGISTRY[name];
  return entry ? structuredClone(entry) : null;
}

/** Return the list of available models for a named provider. */
export function getProviderModels(name) {
  return REGISTRY[name]?.models || [];
}

export async function chat(provider, { messages, tools, onToken, onReasoning, signal } = {}) {
  const defaults = REGISTRY[provider.type] || {};
  const {
    apiKey,
    model = defaults.model,
    baseURL = defaults.baseURL,
    thinking = defaults.thinking || {},
  } = provider;

  const body = {
    model,
    messages,
    stream: true,
  };

  // DeepSeek thinking/reasoning config
  if (thinking.type) {
    body.thinking = { type: thinking.type };
  }
  if (thinking.reasoning_effort) {
    body.reasoning_effort = thinking.reasoning_effort;
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`DeepSeek request failed (${response.status}): ${errText}`);
    }
    throw new Error(`DeepSeek request failed (${response.status}): ${errText}`);
  }

  return parseStream(response, { onToken, onReasoning });
}

/**
 * Parse SSE stream from DeepSeek chat/completions endpoint.
 * Accumulates content, tool_calls, reasoning_content, and usage.
 */
async function parseStream(response, { onToken, onReasoning }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let content = '';
  let reasoning = '';
  let toolCalls = [];
  let usage = null;

  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        // Text content
        if (delta.content) {
          content += delta.content;
          if (onToken) onToken(delta.content);
        }

        // Reasoning/thinking content (DeepSeek thinking mode)
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (onReasoning) onReasoning(delta.reasoning_content);
        }

        // Tool calls (function calling)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? toolCalls.length;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || '',
                type: 'function',
                function: { name: '', arguments: '' },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }

      // Usage (may appear in last chunk)
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  }

  return {
    content: content || null,
    toolCalls: toolCalls.filter(Boolean),
    usage,
    reasoning: reasoning || null,
  };
}
