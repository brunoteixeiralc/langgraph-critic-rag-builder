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
  models: [
    'qwen/qwen3-coder-next', // primary
    // Fallbacks — OpenRouter tries these in order if the primary is
    // rate-limited/unavailable (this is on top of the retry-with-backoff in
    // openrouterService.ts, which retries the primary a few times first).
    'nvidia/nemotron-3.5-lightning:free', // 30B MoE (3B active), 1M context, built for agentic/structured workloads
    'liquid/lfm-2.5-2.6b:free', // small (2.6B), last resort — Liquid AI advises against heavy coding tasks with it
    // https://openrouter.ai/models?fmt=cards&max_price=0&order=throughput-high-to-low&supported_parameters=structured_outputs%2Cresponse_format
    // 'upstage/solar-pro-3:free',
    // 'gpt-oss-120b:free',
  ],
  provider: {
    sort: {
      by: 'throughput', // Route to model with highest throughput (fastest response)
      partition: 'none',
    },
  },
  temperature: 0.7,
  // Used by RagService for Pinecone document embeddings. Must be an actual
  // Gemini *embedding* model (not a generation model like gemini-2.5-flash).
  geminiEmbeddingModel: process.env.GEMINI_MODEL || 'models/gemini-embedding-001',
};
