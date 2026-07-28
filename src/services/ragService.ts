import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { config } from '../config.ts';

export class RagService {
  private vectorStore: PineconeStore | null = null;
  private initFailed = false;

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
    if (!this.vectorStore) await this.init();
    if (!this.vectorStore) return "";

    try {
      console.log(`[RAG] Searching Pinecone context for: "${query}"...`);
      const filter = filterNiche ? { niche: filterNiche } : undefined;
      const results = await this.vectorStore.similaritySearch(query, 4, filter);

      if (results.length === 0) return "";
      return results.map(doc => `[Source: ${doc.metadata?.source || 'Unknown'}]\n${doc.pageContent}`).join('\n\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[RAG] ❌ Search failed for query "${query}": ${message}. Continuing without this context.`);
      return "";
    }
  }
}

// Shared singleton — specialist nodes import this instead of instantiating
// their own RagService, so the Pinecone client + embeddings model are
// initialized once per process and reused across every node call/retry
// instead of reconnecting on every single invocation.
export const ragService = new RagService();
