/**
 * fetch tool — fetch a URL and return its content as text.
 */
export const fetchTool = {
  name: 'fetch',
  description:
    'Fetch a URL and return its content as text. HTML pages are stripped to readable text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http/https URL' },
    },
    required: ['url'],
  },
  readonly: true,
  parallel: true,

  async execute(args, _agent) {
    try {
      const response = await fetch(args.url, {
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      // If HTML, strip tags for readability
      if (contentType.includes('html') || text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
        const stripped = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();

        return stripped.slice(0, 50_000) +
          (stripped.length > 50_000 ? '\n\n[truncated]' : '');
      }

      return text.slice(0, 50_000) +
        (text.length > 50_000 ? '\n\n[truncated]' : '');
    } catch (err) {
      return `Error fetching URL: ${err.message}`;
    }
  },
};
