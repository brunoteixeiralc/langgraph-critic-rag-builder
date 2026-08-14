/**
 * SSRF guard for fetchUrlContent(). Any URL pasted into a user's `topic` (or
 * discovered while expanding an index page during ingestion) gets fetched
 * server-side — without a check, an attacker holding a valid SERVER_API_KEY
 * could point that fetch at cloud metadata endpoints (169.254.169.254),
 * localhost, or internal RFC1918 addresses and have the response reflected
 * back inside the generated post.
 *
 * Approach: only `http`/`https` protocols are allowed, and the resolved
 * IP address(es) must be in the public "unicast" range per ipaddr.js — an
 * allowlist, not a denylist, so any newly-classified special-purpose range
 * (link-local, CGNAT, benchmarking, etc.) is excluded by default rather than
 * requiring this file to be updated every time a new reserved range ships.
 *
 * Known residual risk (DNS rebinding): this resolves the hostname once to
 * validate it, then the actual `fetch()` call resolves it again — a
 * malicious DNS server could theoretically return a public IP for our check
 * and a private one moments later for the real request. Fully closing that
 * gap means pinning the connection to the IP we validated (custom dispatcher
 * + Host header), which is meaningfully more code for a project whose
 * threat model is "a topic string, not a multi-tenant public API". Accepted
 * as a known limitation — revisit if this ever takes untrusted input from
 * outside a single trusted operator.
 */
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type UrlSafetyResult = { safe: true } | { safe: false; reason: string };

function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false; // be conservative: unparseable = not safe
  const addr = ipaddr.process(address); // normalizes IPv4-mapped IPv6 (::ffff:10.0.0.1) etc.
  return addr.range() === 'unicast';
}

export async function assertUrlIsSafeToFetch(rawUrl: string): Promise<UrlSafetyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Malformed URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: `Protocol "${url.protocol}" is not allowed — only http/https.` };
  }

  // A literal IP in the URL (e.g. http://169.254.169.254/...) — no DNS
  // lookup needed, check it directly.
  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip [] from IPv6 literals
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) {
      return { safe: false, reason: `"${hostname}" is a private/reserved/loopback IP address.` };
    }
    return { safe: true };
  }

  // Hostname — resolve and check every address it maps to.
  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `DNS lookup failed for "${hostname}": ${message}` };
  }

  if (addresses.length === 0) {
    return { safe: false, reason: `"${hostname}" did not resolve to any address.` };
  }

  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      return { safe: false, reason: `"${hostname}" resolves to a private/reserved IP (${address}).` };
    }
  }

  return { safe: true };
}
