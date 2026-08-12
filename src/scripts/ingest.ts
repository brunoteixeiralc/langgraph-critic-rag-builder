/**
 * Pinecone ingestion script.
 *
 * Reads src/scripts/sources.json (niche -> array of URLs), fetches each page,
 * chunks the text, embeds it with the same Gemini model RagService uses for
 * queries (config.geminiEmbeddingModel — must match, or search results won't
 * make sense), and upserts into the Pinecone index/namespace RagService
 * reads from ("posts-content").
 *
 * Safe to re-run: each chunk gets a deterministic ID (hash of source URL +
 * chunk index), so re-ingesting the same source overwrites its old vectors
 * instead of duplicating them. If a source shrinks (fewer chunks than last
 * time), the leftover old chunks are deleted at the end of that source's run.
 *
 * Usage:
 *   npm run ingest              # ingest everything in sources.json
 *   npm run ingest -- --niche=ios   # ingest only one niche
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

const SOURCES_PATH = path.join(process.cwd(), 'src/scripts/sources.json');
const NAMESPACE = 'posts-content'; // must match ragService.ts

// Character-based chunking (no tokenizer dependency). ~3000 chars is roughly
// 700-800 tokens for English/code-heavy text — a reasonable retrieval unit.
const CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 300;

// Ingestion can pull whole doc pages, not just a fragment for one prompt —
// much higher cap than the 12K default used for live [WEB_DATA] grounding.
const MAX_PAGE_CHARS = 300_000;

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

async function main() {
  const nicheFilter = parseNicheFilter();

  const raw = await fs.readFile(SOURCES_PATH, 'utf-8');
  const sources: SourcesConfig = JSON.parse(raw);

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

  for (const [niche, urls] of Object.entries(sources)) {
    if (nicheFilter && niche !== nicheFilter) continue;
    if (urls.length === 0) continue;

    console.log(`\n=== Niche: ${niche} (${urls.length} source${urls.length === 1 ? '' : 's'}) ===`);

    for (const url of urls) {
      console.log(`[Ingest] Fetching: ${url}`);
      const content = await fetchUrlContent(url, MAX_PAGE_CHARS);

      if (!content) {
        console.warn(`[Ingest] ⚠️  Skipped (fetch failed or content too short): ${url}`);
        totalSkipped++;
        continue;
      }

      const chunks = chunkText(content, CHUNK_SIZE, CHUNK_OVERLAP);
      const docs = chunks.map(
        (chunk, i) =>
          new Document({
            pageContent: chunk,
            metadata: { niche, source: url, chunkIndex: i, ingestedAt: new Date().toISOString() },
          }),
      );
      const ids = chunks.map((_, i) => chunkId(url, i));

      await vectorStore.addDocuments(docs, ids);

      // Clean up leftover chunks from a previous, longer version of this
      // same source (e.g. if the page shrank from 8 chunks to 5, delete the
      // now-orphaned chunk IDs 5, 6, 7 so stale content doesn't linger).
      const orphanIds: string[] = [];
      for (let i = chunks.length; i < chunks.length + 20; i++) {
        orphanIds.push(chunkId(url, i));
      }
      await pineconeIndex.namespace(NAMESPACE).deleteMany(orphanIds).catch(() => {
        // ignore — ids that don't exist are a no-op on Pinecone's side anyway,
        // this catch just guards against transient errors on a best-effort cleanup
      });

      console.log(`[Ingest] ✅ Upserted ${docs.length} chunk(s) for: ${url}`);
      totalChunks += docs.length;
      totalSources++;
    }
  }

  console.log(`\n✅ Ingestion complete. ${totalSources} source(s) processed, ${totalChunks} chunk(s) upserted, ${totalSkipped} skipped.`);
}

main().catch((err) => {
  console.error('❌ Ingestion failed:', err);
  process.exit(1);
});
