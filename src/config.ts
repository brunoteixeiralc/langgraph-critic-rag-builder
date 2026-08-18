export type ModelConfig = {
  apiKey: string;
  httpReferer: string;
  xTitle: string;

  provider: {
    sort: {
      by: string;
      partition: string;
    };
  };

  models: string[];
  temperature: number;

  geminiEmbeddingModel: string;
};

console.assert(process.env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY is not set in environment variables');

export const config: ModelConfig = {
  apiKey: process.env.OPENROUTER_API_KEY!,
  httpReferer: process.env.OPENROUTER_HTTP_REFERER || '',
  xTitle: process.env.OPENROUTER_X_TITLE || 'IA Devs - Prompt Chaining Article Generator',
  // 2026-08-18: found via a direct query of https://openrouter.ai/api/v1/models
  // that the old primary ('qwen/qwen3-coder-next') and one of the two free
  // fallbacks ('liquid/lfm-2.5-2.6b:free') had both been removed from
  // OpenRouter's catalog entirely — not rate-limited, just gone. That meant
  // effectively every single generation had silently been running on the
  // one fallback that still existed, 'nvidia/nemotron-3.5-lightning:free',
  // which explains the real incidents this traced back to (an 8+ minute
  // hang on one call, a truncated/garbled final post: a free, shared-quota
  // model is exactly what produces that). Replaced with two paid-but-cheap
  // models, verified directly against the live models list (not memory):
  // both confirmed to support response_format/structured_outputs/tools in
  // their supported_parameters, which providerStrategy() depends on.
  models: [
    // $0.14 / $0.28 per M tokens (in/out), 1.3M context. Description:
    // "suited for coding, reasoning, and agent workflows" — good primary.
    'deepseek/deepseek-v4-flash-0731',
    // ~$0.10 / $0.60 per M tokens, 1.05M context. Different provider/lab
    // entirely (OpenAI vs DeepSeek) — real failover diversity if the
    // primary's provider has an outage, not just a cheaper copy of it.
    'openai/gpt-5.6-luna',
  ],
  provider: {
    sort: {
      // 'throughput' optimizes tokens/sec once generation has started, which
      // matters for long streamed completions. Our calls are bounded-size
      // JSON (a LinkedIn post, not an essay), so overall responsiveness —
      // dispatch + time-to-first-token + total completion time — matters
      // more than raw tokens/sec. OpenRouter's own routing docs recommend
      // 'latency' for exactly this case.
      by: 'latency',
      partition: 'none',
    },
  },
  temperature: 0.7,
  // Used by RagService for Pinecone document embeddings. Must be an actual
  // Gemini *embedding* model (not a generation model like gemini-2.5-flash).
  geminiEmbeddingModel: process.env.GEMINI_MODEL || 'models/gemini-embedding-001',
};
