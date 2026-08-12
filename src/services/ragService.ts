import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { config } from '../config.ts';

// In-memory cache for retrieveContext(query, niche) -> result text. Every
// call embeds the query via the Gemini API, which is the tightest free-tier
// budget in this app (TPM quota, and the "prepayment credits depleted"
// issue). The same topics get hit repeatedly in practice — manual curl
// testing, the reviewer's initial+corrective query pair sometimes
// overlapping, and eval.ts running the same fixed dataset over and over —
// so a short-lived cache avoids re-embedding identical text for free.
// Process-lifetime only (no persistence): fine for server.ts (long-running)
// and run-eval.ts (single run), and never serves data older than the TTL,
// so a fresh `npm run ingest` is reflected soon after.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX_ENTRIES = 200; // bounded so a long-running server process can't leak memory

type CacheEntry = { value: string; expiresAt: number };

export class RagService {
  private vectorStore: PineconeStore | null = null;
  private initFailed = false;
  private cache = new Map<string, CacheEntry>();

  async init() {
    try {
      const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
      const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME!);
      const embeddings = new GoogleGenerativeAIEmbeddings({
        apiKey: process.env.GEMINI_API_KEY!,
        model: config.geminiEmbeddingModel,
      });

      this.vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex,
        namespace: "posts-content",
      });
    } catch (err) {
      // Don't let a missing/misconfigured Pinecone index crash the whole graph.
      // Specialists should still be able to produce a draft without RAG grounding.
      this.initFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[RAG] ❌ Failed to initialize Pinecone vector store: ${message}`);
      console.error(`[RAG] Check PINECONE_API_KEY, PINECONE_INDEX_NAME, and GEMINI_API_KEY in .env. Continuing without RAG context.`);
    }
  }

  async retrieveContext(query: string, filterNiche?: string): Promise<string> {
    if (this.initFailed) return "";

    const cacheKey = `${filterNiche ?? ''}::${query}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[RAG] ⚡ Cache hit for: "${query}" — skipping Gemini embedding call.`);
      return cached.value;
    }

    if (!this.vectorStore) await this.init();
    if (!this.vectorStore) return "";

    try {
      console.log(`[RAG] Searching Pinecone context for: "${query}"...`);
      const filter = filterNiche ? { niche: filterNiche } : undefined;
      const results = await this.vectorStore.similaritySearch(query, 4, filter);

      const context = results.length === 0
        ? ""
        : results.map(doc => `[Source: ${doc.metadata?.source || 'Unknown'}]\n${doc.pageContent}`).join('\n\n');

      this.setCache(cacheKey, context);
      return context;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[RAG] ❌ Search failed for query "${query}": ${message}. Continuing without this context.`);
      return "";
    }
  }

  private setCache(key: string, value: string) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Evict the oldest entry (Map preserves insertion order) — simple,
      // good enough for a bounded free-tier-saving cache, no need for real LRU.
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

// Shared singleton — specialist nodes import this instead of instantiating
// their own RagService, so the Pinecone client + embeddings model are
// initialized once per process and reused across every node call/retry
// instead of reconnecting on every single invocation.
export const ragService = new RagService();
