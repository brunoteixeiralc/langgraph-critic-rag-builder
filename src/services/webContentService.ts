import { assertUrlIsSafeToFetch } from './urlSafety.ts';

/**
 * Extracts all HTTP/HTTPS URLs from a given text string.
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s"')]+/g;
  return text.match(urlRegex) ?? [];
}

const MAX_REDIRECTS = 3;

/**
 * fetch() with `redirect: 'manual'`, re-validating each hop against the SSRF
 * guard before following it. A server we already confirmed is safe could
 * still 302 us to http://169.254.169.254/... — auto-following redirects
 * (fetch's default) would bypass the check on the very first request.
 */
async function fetchWithSafeRedirects(startUrl: string, signal: AbortSignal): Promise<Response | null> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safety = await assertUrlIsSafeToFetch(currentUrl);
    if (!safety.safe) {
      console.warn(`[URL Fetch] Blocked by SSRF guard: ${currentUrl} — ${safety.reason}`);
      return null;
    }

    const response = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentBuilder/1.0)' },
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (!isRedirect || !location) return response;

    currentUrl = new URL(location, currentUrl).toString();
  }

  console.warn(`[URL Fetch] Too many redirects (>${MAX_REDIRECTS}) starting from: ${startUrl}`);
  return null;
}

/**
 * Fetches the text content of a URL, stripping HTML tags.
 * Returns null if the fetch fails, is blocked by the SSRF guard, or the
 * content is too short to be meaningful.
 *
 * @param maxChars - Truncate the result to this length. Defaults to 12K, sized
 *   to fit comfortably inside an LLM prompt (used by the specialist nodes for
 *   live [WEB_DATA] grounding). Pass a much larger value (or Infinity) for
 *   bulk ingestion, where the text gets chunked afterward instead of shoved
 *   whole into a single prompt — see src/scripts/ingest.ts.
 */
export async function fetchUrlContent(url: string, maxChars: number = 12_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000); // 15s hard timeout

    const response = await fetchWithSafeRedirects(url, controller.signal);
    clearTimeout(timeout);

    if (!response) return null; // blocked by SSRF guard, or too many redirects

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

    // Only return if the content is meaningful
    return text.length > 200 ? text.substring(0, maxChars) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[URL Fetch] Failed to fetch ${url}: ${message}`);
    return null;
  }
}
