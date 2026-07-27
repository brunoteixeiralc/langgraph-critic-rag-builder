/**
 * Extracts all HTTP/HTTPS URLs from a given text string.
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s"')]+/g;
  return text.match(urlRegex) ?? [];
}

/**
 * Fetches the text content of a URL, stripping HTML tags.
 * Returns null if the fetch fails or the content is too short to be meaningful.
 */
export async function fetchUrlContent(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s hard timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentBuilder/1.0)' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[URL Fetch] HTTP ${response.status} for: ${url}`);
      return null;
    }

    const html = await response.text();
    // Strip scripts, styles, and all HTML tags for clean text extraction
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{3,}/g, '\n\n')
      .trim();

    // Only return if the content is meaningful; cap at 12K chars to stay within token budget
    return text.length > 200 ? text.substring(0, 12_000) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[URL Fetch] Failed to fetch ${url}: ${message}`);
    return null;
  }
}
