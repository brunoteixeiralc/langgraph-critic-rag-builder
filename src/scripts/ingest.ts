/**
 * Pinecone ingestion script.
 *
 * Reads src/scripts/sources.json (niche -> array of URLs), fetches each page,
 * chunks the text, embeds it with the same Gemini model RagService uses for
 * queries (config.geminiEmbeddingModel — must match, or search results won't
 * make sense), and upserts into the Pinecone index/namespace RagService
 * reads from ("posts-content").
 *
 * Auto-expansion for listing/index pages:
 *   - GitHub "tree" URLs (e.g. .../tree/main/proposals) are never fetched
 *     directly — GitHub renders the file list client-side, so a raw HTML
 *     fetch would return near-empty content. Instead we call the GitHub
 *     Contents API to list the directory and ingest each file's raw content
 *     individually (capped at GITHUB_TREE_FILE_CAP files, most recent first
 *     when filenames are numerically prefixed, e.g. Swift Evolution
 *     proposals).
 *   - Any other URL is fetched normally first. If the scraped text is
 *     suspiciously thin (< MIN_CONTENT_FOR_SINGLE_PAGE chars — a strong sign
 *     it's an index/nav page rather than real content), we re-fetch the raw
 *     HTML, extract same-origin links that are exactly one path segment
 *     deeper than the index page, and ingest each of those child pages
 *     instead (capped at INDEX_CHILD_LINK_CAP links).
 *
 * Safe to re-run: each chunk gets a deterministic ID (hash of the resolved
 * source URL + chunk index), so re-ingesting overwrites old vectors instead
 * of duplicating them. If a source shrinks (fewer chunks than last time),
 * the leftover old chunks are deleted at the end of that source's run.
 *
 * Free-tier friendly: a local manifest (src/scripts/.ingest-manifest.json)
 * remembers the content hash of every source already embedded. On the next
 * run, unchanged sources are skipped entirely — no embedding call is made —
 * which matters a lot on Gemini's free tier (low TPM quota). Use --force to
 * bypass the manifest and re-embed everything (e.g. after recreating the
 * Pinecone index).
 *
 * Usage:
 *   npm run ingest                  # ingest everything in sources.json (skips unchanged)
 *   npm run ingest -- --niche=ios   # ingest only one niche
 *   npm run ingest -- --force       # ignore the manifest, re-embed everything
 *
 * Requires PINECONE_API_KEY, PINECONE_INDEX_NAME, GEMINI_API_KEY in .env
 * (same as the running app). The Pinecone index must already exist — this
 * script does not create it.
 */
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from '@langchain/pinecone';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { Document } from '@langchain/core/documents';
import { config } from '../config.ts';
import { fetchUrlContent } from '../services/webContentService.ts';

type SourcesConfig = Record<string, string[]>; // niche -> URLs

type ResolvedSource = { source: string; content: string };

type GithubContentEntry = {
  type: string;
  name: string;
  download_url: string | null;
};

type ManifestEntry = { contentHash: string; chunkCount: number; ingestedAt: string };
type Manifest = Record<string, ManifestEntry>; // source URL -> last-ingested state

const SOURCES_PATH = path.join(process.cwd(), 'src/scripts/sources.json');
const MANIFEST_PATH = path.join(process.cwd(), 'src/scripts/.ingest-manifest.json');
const NAMESPACE = 'posts-content'; // must match ragService.ts

// Character-based chunking (no tokenizer dependency). ~3000 chars is roughly
// 700-800 tokens for English/code-heavy text — a reasonable retrieval unit.
const CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 300;

// Ingestion can pull whole doc pages, not just a fragment for one prompt —
// much higher cap than the 12K default used for live [WEB_DATA] grounding.
const MAX_PAGE_CHARS = 300_000;

// Below this, a scraped page is treated as a thin index/listing page instead
// of real content, and expansion into child pages is attempted.
const MIN_CONTENT_FOR_SINGLE_PAGE = 500;

// Safety caps so one config line can't silently trigger thousands of
// embedding calls (cost + time). Kept conservative to stay comfortably
// inside Gemini's free-tier TPM quota — raise if you've moved to a paid tier.
const GITHUB_TREE_FILE_CAP = 15;
const INDEX_CHILD_LINK_CAP = 15;

// Gemini's free-tier embedding quota is easy to blow through when ingesting
// many sources back-to-back — specifically TPM (tokens/minute), not RPM.
// When TPM is exhausted, LangChain's embeddings wrapper can swallow the
// underlying 429 and hand Pinecone an empty vector, which surfaces as a
// confusing "Vector dimension 0" error instead of a clear rate-limit
// message. Since TPM is a rolling 60s window, a short backoff (a few
// seconds) just re-fails immediately — the retry has to wait out most of
// the window. Non-rate-limit errors (network blips, etc.) still use a
// short backoff.
const EMBED_RETRY_ATTEMPTS = 4;
const SHORT_RETRY_BASE_MS = 4000; // 4s, 8s, 12s — transient/non-quota errors
const RATE_LIMIT_WAIT_MS = 65_000; // covers a full TPM window with margin
const INTER_SOURCE_DELAY_MS = 1500; // pace requests to avoid tripping TPM in the first place

function isRateLimitError(message: string): boolean {
  return /dimension 0|rate.?limit|quota|resource_exhausted|429/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GITHUB_TREE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/;

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function chunkId(source: string, index: number): string {
  return createHash('sha256').update(`${source}#${index}`).digest('hex').slice(0, 32);
}

function parseNicheFilter(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--niche='));
  return arg ? arg.split('=')[1] : null;
}

function parseForceFlag(): boolean {
  return process.argv.includes('--force');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function loadManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return {}; // no manifest yet — first run, or it was deleted
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Lists a GitHub directory via the Contents API and returns raw file URLs,
 * most-recent-first when names are numerically prefixed (e.g. Swift
 * Evolution's "0123-some-proposal.md"), capped at GITHUB_TREE_FILE_CAP.
 */
async function listGithubTreeFiles(owner: string, repo: string, branch: string, dirPath: string): Promise<string[]> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'ContentBuilder/1.0', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      console.warn(`[Ingest] ⚠️  GitHub API ${res.status} for ${dirPath} — cannot expand this tree URL.`);
      return [];
    }
    const items = (await res.json()) as GithubContentEntry[];
    if (!Array.isArray(items)) {
      console.warn(`[Ingest] ⚠️  Unexpected GitHub API response for ${dirPath} — cannot expand this tree URL.`);
      return [];
    }
    const files = items
      .filter((it) => it.type === 'file' && it.name.toLowerCase().endsWith('.md') && it.download_url)
      .sort((a, b) => b.name.localeCompare(a.name)) // numeric prefixes sort newest-first
      .slice(0, GITHUB_TREE_FILE_CAP)
      .map((it) => it.download_url as string);
    if (files.length === 0) {
      console.warn(`[Ingest] ⚠️  No .md files found under ${dirPath}.`);
    } else {
      console.log(`[Ingest] 📂 Expanded GitHub tree "${dirPath}" into ${files.length} file(s) (capped at ${GITHUB_TREE_FILE_CAP}).`);
    }
    return files;
  } catch (e) {
    console.warn(`[Ingest] ⚠️  Failed to list GitHub tree ${dirPath}:`, e);
    return [];
  }
}

/**
 * Fetches raw HTML for an index-like page and extracts same-origin links
 * that sit exactly one path segment deeper than the page itself (i.e. likely
 * child/detail pages of a listing page). Capped at INDEX_CHILD_LINK_CAP.
 */
async function findIndexPageChildLinks(url: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentBuilder/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return [];

    const html = await res.text();
    const base = new URL(url);
    const basePath = base.pathname.replace(/\/+$/, '');

    const hrefRe = /href="([^"]+)"/g;
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = hrefRe.exec(html))) {
      const href = match[1];
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;

      let resolved: URL;
      try {
        resolved = new URL(href, base);
      } catch {
        continue;
      }
      if (resolved.origin !== base.origin) continue;

      const childPath = resolved.pathname.replace(/\/+$/, '');
      if (childPath === basePath || !childPath.startsWith(`${basePath}/`)) continue;

      const remainder = childPath.slice(basePath.length + 1);
      if (!remainder || remainder.includes('/')) continue; // only exactly one level deeper

      resolved.hash = '';
      resolved.search = '';
      found.add(resolved.toString());
    }

    const links = Array.from(found).slice(0, INDEX_CHILD_LINK_CAP);
    if (links.length > 0) {
      console.log(`[Ingest] 📂 "${url}" looked like an index page — found ${links.length} child page(s) (capped at ${INDEX_CHILD_LINK_CAP}).`);
    }
    return links;
  } catch (e) {
    console.warn(`[Ingest] ⚠️  Failed to scan index page ${url} for child links:`, e);
    return [];
  }
}

/**
 * Resolves one configured URL into one or more (source, content) pairs,
 * transparently expanding GitHub tree URLs and thin index/listing pages.
 */
async function resolveSources(url: string): Promise<ResolvedSource[]> {
  const ghMatch = url.match(GITHUB_TREE_RE);
  if (ghMatch) {
    const [, owner, repo, branch, dirPath] = ghMatch;
    const files = await listGithubTreeFiles(owner, repo, branch, dirPath);
    const results: ResolvedSource[] = [];
    for (const fileUrl of files) {
      const content = await fetchUrlContent(fileUrl, MAX_PAGE_CHARS);
      if (content) {
        results.push({ source: fileUrl, content });
      } else {
        console.warn(`[Ingest] ⚠️  Skipped (fetch failed): ${fileUrl}`);
      }
    }
    return results;
  }

  const directContent = await fetchUrlContent(url, MAX_PAGE_CHARS);
  if (directContent && directContent.length >= MIN_CONTENT_FOR_SINGLE_PAGE) {
    return [{ source: url, content: directContent }];
  }

  console.log(`[Ingest] 🔎 "${url}" content is thin (${directContent?.length ?? 0} chars) — checking for child pages...`);
  const childLinks = await findIndexPageChildLinks(url);
  if (childLinks.length === 0) {
    // No expansion possible — fall back to whatever we had, even if thin/null.
    return directContent ? [{ source: url, content: directContent }] : [];
  }

  const results: ResolvedSource[] = [];
  for (const childUrl of childLinks) {
    const content = await fetchUrlContent(childUrl, MAX_PAGE_CHARS);
    if (content) {
      results.push({ source: childUrl, content });
    } else {
      console.warn(`[Ingest] ⚠️  Skipped child (fetch failed): ${childUrl}`);
    }
  }
  if (results.length > 0) return results;
  return directContent ? [{ source: url, content: directContent }] : [];
}

/**
 * Upserts one source's chunks with retry+backoff. Returns false (instead of
 * throwing) if all attempts fail, so the caller can skip this source and
 * keep processing the rest of the run instead of losing all prior progress.
 */
async function addDocumentsWithRetry(
  vectorStore: PineconeStore,
  docs: Document[],
  ids: string[],
  source: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= EMBED_RETRY_ATTEMPTS; attempt++) {
    try {
      await vectorStore.addDocuments(docs, ids);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isLastAttempt = attempt === EMBED_RETRY_ATTEMPTS;
      if (isLastAttempt) {
        console.error(`[Ingest] ❌ Failed to upsert "${source}" after ${attempt} attempt(s): ${message}`);
        return false;
      }
      const rateLimited = isRateLimitError(message);
      const delay = rateLimited ? RATE_LIMIT_WAIT_MS : SHORT_RETRY_BASE_MS * attempt;
      console.warn(`[Ingest] ⚠️  Upsert error for "${source}" (attempt ${attempt}/${EMBED_RETRY_ATTEMPTS}${rateLimited ? ', TPM rate limit' : ''}) — retrying in ${Math.round(delay / 1000)}s: ${message}`);
      await sleep(delay);
    }
  }
  return false;
}

async function main() {
  // Ingestion fires many rapid Gemini embedding calls in a tight loop —
  // tracing each one floods LangSmith with low-value noise. Disable tracing
  // just for this script; the actual multi-agent graph runs (src/server.ts,
  // local `npm start`) still get traced normally via the LANGSMITH_* vars.
  process.env.LANGSMITH_TRACING = 'false';
  process.env.LANGCHAIN_TRACING_V2 = 'false';

  const nicheFilter = parseNicheFilter();
  const force = parseForceFlag();

  const raw = await fs.readFile(SOURCES_PATH, 'utf-8');
  const sources: SourcesConfig = JSON.parse(raw);
  const manifest = await loadManifest();
  if (force) {
    console.log('[Ingest] --force set: ignoring manifest, re-embedding everything.');
  }

  if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME || !process.env.GEMINI_API_KEY) {
    console.error('❌ Missing PINECONE_API_KEY, PINECONE_INDEX_NAME, or GEMINI_API_KEY in .env. Aborting.');
    process.exit(1);
  }

  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GEMINI_API_KEY,
    model: config.geminiEmbeddingModel,
  });
  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    namespace: NAMESPACE,
  });

  let totalChunks = 0;
  let totalSources = 0;
  let totalSkipped = 0;
  let totalUnchanged = 0;

  for (const [niche, urls] of Object.entries(sources)) {
    if (nicheFilter && niche !== nicheFilter) continue;
    if (urls.length === 0) continue;

    console.log(`\n=== Niche: ${niche} (${urls.length} configured source${urls.length === 1 ? '' : 's'}) ===`);

    for (const url of urls) {
      console.log(`[Ingest] Resolving: ${url}`);
      const resolved = await resolveSources(url);

      if (resolved.length === 0) {
        console.warn(`[Ingest] ⚠️  Skipped (no content found): ${url}`);
        totalSkipped++;
        continue;
      }

      for (const { source, content } of resolved) {
        const hash = contentHash(content);
        const cached = manifest[source];
        if (!force && cached && cached.contentHash === hash) {
          console.log(`[Ingest] ⏭️  Unchanged since last ingest, skipping embedding call: ${source}`);
          totalUnchanged++;
          continue;
        }

        const chunks = chunkText(content, CHUNK_SIZE, CHUNK_OVERLAP);
        const docs = chunks.map(
          (chunk, i) =>
            new Document({
              pageContent: chunk,
              metadata: { niche, source, chunkIndex: i, ingestedAt: new Date().toISOString() },
            }),
        );
        const ids = chunks.map((_, i) => chunkId(source, i));

        const ok = await addDocumentsWithRetry(vectorStore, docs, ids, source);
        if (!ok) {
          totalSkipped++;
          await sleep(INTER_SOURCE_DELAY_MS);
          continue;
        }

        // Clean up leftover chunks from a previous, longer version of this
        // same source (e.g. if the page shrank from 8 chunks to 5, delete the
        // now-orphaned chunk IDs 5, 6, 7 so stale content doesn't linger).
        const orphanIds: string[] = [];
        for (let i = chunks.length; i < chunks.length + 20; i++) {
          orphanIds.push(chunkId(source, i));
        }
        await pineconeIndex.namespace(NAMESPACE).deleteMany(orphanIds).catch(() => {
          // ignore — ids that don't exist are a no-op on Pinecone's side anyway,
          // this catch just guards against transient errors on a best-effort cleanup
        });

        console.log(`[Ingest] ✅ Upserted ${docs.length} chunk(s) for: ${source}`);
        totalChunks += docs.length;
        totalSources++;

        manifest[source] = { contentHash: hash, chunkCount: chunks.length, ingestedAt: new Date().toISOString() };
        await saveManifest(manifest); // persist incrementally so a crash mid-run doesn't lose already-embedded progress

        await sleep(INTER_SOURCE_DELAY_MS);
      }
    }
  }

  console.log(`\n✅ Ingestion complete. ${totalSources} source(s) embedded, ${totalChunks} chunk(s) upserted, ${totalUnchanged} unchanged (skipped), ${totalSkipped} failed.`);
}

main().catch((err) => {
  console.error('❌ Ingestion failed:', err);
  process.exit(1);
});
