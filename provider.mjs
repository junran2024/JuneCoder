/**
 * DeepSeek LLM provider — calls api.deepseek.com/chat/completions.
 *
 * @param {object} provider
 * @param {string} provider.apiKey - DeepSeek API key
 * @param {string} [provider.model='deepseek-v4-pro']
 * @param {string} [provider.baseURL='https://api.deepseek.com']
 * @param {object} [provider.thinking] - thinking/reasoning config
 * @param {string} [provider.thinking.type='enabled'] - "enabled" | "disabled"
 * @param {string} [provider.thinking.reasoning_effort] - "low"|"medium"|"high"
 * @param {object} opts
 * @param {object[]} opts.messages
 * @param {object[]} [opts.tools]
 * @param {(token: string) => void} [opts.onToken]
 * @param {(reasoning: string) => void} [opts.onReasoning]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ content: string|null, toolCalls: object[], usage: object|null, reasoning: string|null }>}
 */
export async function chat(provider, { messages, tools, onToken, onReasoning, signal } = {}) {
  const {
    apiKey,
    model = 'deepseek-v4-pro',
    baseURL = 'https://api.deepseek.com',
    thinking = { type: 'enabled' },
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
    throw new Error(`Use /key to setup API key. DeepSeek request failed (${response.status}): ${errText}`);
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
