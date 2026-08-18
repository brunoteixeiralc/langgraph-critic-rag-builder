import { ChatOpenAI } from '@langchain/openai';
import { config, type ModelConfig } from '../config.ts';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { z } from 'zod/v3';
import { createAgent, providerStrategy } from 'langchain';

export type LLMResponse = {
  model: string;
  content: string;
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2s, 4s, 8s (exponential backoff)

export function isRetryableError(error: unknown): boolean {
  const err = error as { status?: number; lc_error_code?: string; message?: string } | undefined;
  if (!err) return false;
  if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503) return true;
  if (err.lc_error_code === 'MODEL_RATE_LIMIT') return true;
  const message = err.message ?? '';
  // "Model output did not satisfy the provided response schema" — providerStrategy's
  // structured-output parser throws this when the model's JSON doesn't match the Zod
  // schema (missing/malformed fields). This is a model-quality hiccup, not a request
  // problem: OpenRouter's fallback list (this.config.models) can route the retry to a
  // different underlying model/provider, and even on the same model, generation is
  // stochastic — a second attempt often just succeeds. Previously this fell through
  // to "non-retryable" and killed the whole node on the first bad output.
  if (/did not satisfy the provided response schema|failed to parse structured output/i.test(message)) return true;
  return /429|rate.?limit|timeout|ECONNRESET|ETIMEDOUT/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenRouterService {
  private llmClient: ChatOpenAI;
  private config: ModelConfig;

  constructor(configOverride?: ModelConfig) {
    this.config = configOverride ?? config;

    this.llmClient = new ChatOpenAI({
      apiKey: this.config.apiKey,
      modelName: this.config.models[0],
      temperature: this.config.temperature,
      // No explicit cap previously — fell back to whatever default the
      // provider/model applies, which truncated the Reviewer's postText
      // mid-sentence on a real run (long technicalDraft, reviewer has to
      // reproduce the entire post in one structured-output field). 4096 is
      // generous enough for a full LinkedIn post + hashtags + the schema's
      // other fields (feedback/corrections, empty when approved) with room
      // to spare.
      maxTokens: 4096,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': this.config.httpReferer,
          'X-Title': this.config.xTitle,
        },
      },

      modelKwargs: {
        models: this.config.models,
        provider: this.config.provider,
      },
    });
  }

  async generateStructured<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
  ) {
    const agent = createAgent({
      model: this.llmClient,
      tools: [],
      responseFormat: providerStrategy(schema),
    });

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await agent.invoke({ messages });
        return {
          success: true,
          data: data.structuredResponse as T,
        };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableError(error);
        const message = error instanceof Error ? error.message : String(error);

        if (!retryable || attempt === MAX_RETRIES) {
          console.error(`🔴 LLM Error (attempt ${attempt}/${MAX_RETRIES}, ${retryable ? 'retryable but out of attempts' : 'non-retryable'}):`, message);
          break;
        }

        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`⚠️  LLM call failed (attempt ${attempt}/${MAX_RETRIES}, retryable): ${message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }

    return {
      success: false,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }
}
