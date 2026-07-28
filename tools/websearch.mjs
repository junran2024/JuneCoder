/**
 * websearch tool — search the web (Bing).
 */
export const websearchTool = {
  name: 'websearch',
  description:
    'Search the web (Bing). Returns result titles, URLs, and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 8)' },
    },
    required: ['query'],
  },
  readonly: true,
  parallel: true,

  async execute(args, _agent) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(args.query)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; junecoder/1.0)',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status}`;
      }

      const html = await response.text();

      // Parse Bing results (simple regex extraction)
      const results = [];
      const snippetRegex = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
      let match;

      while ((match = snippetRegex.exec(html)) !== null && results.length < (args.limit || 8)) {
        const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (title && snippet) {
          results.push({ title, url: match[1], snippet });
        }
      }

      if (results.length === 0) return '(no search results found)';

      return results
        .map((r) => `${r.title}\n  ${r.url}\n  ${r.snippet}`)
        .join('\n\n');
    } catch (err) {
      return `Error searching web: ${err.message}`;
    }
  },
};
