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

// A real production run showed a single LLM call (no rate-limit, no error —
// just silence) hang for 8+ minutes, blowing straight through the coarse
// 600s whole-graph timeout in server.ts. That outer timeout doesn't cancel
// the underlying call either, so it kept running as an orphaned "zombie"
// after the job had already been marked failed and returned to the user —
// which is why LangSmith showed a trace still executing well after the
// preview page got its error. Bounding each individual call means a stall
// fails fast and retries (below) instead of silently eating the whole
// budget.
//
// Started at 90s; bumped to 150s after a real run on a heavy Reviewer call
// hit the 90s ceiling twice in a row before a 3rd attempt finally came back
// in ~20s — that's the model genuinely being slow on a big payload, not
// hanging, and it burned a whole review attempt (out of only
// MAX_REVIEW_ATTEMPTS=3) on pure infrastructure retries before any actual
// content review happened. The graph as a whole can still take several
// minutes across review loops regardless of this per-call bound.
//
// IMPORTANT: this used to be passed as `{ timeout: LLM_CALL_TIMEOUT_MS }` in
// agent.invoke()'s RunnableConfig, trusting LangChain to convert it into an
// AbortSignal and honor it. A real LangSmith trace proved that doesn't
// actually bound the call: with timeoutMs=150000 correctly recorded in the
// run's own metadata, two separate Reviewer calls both still ran for
// 456.01s — the signal isn't propagated down to the actual underlying model
// call through createAgent/LangGraph's internals (or isn't checked by
// whatever retry logic is in the OpenAI SDK/langchain-openai layer beneath
// it). raceWithTimeout() below is the same explicit Promise.race pattern
// already proven to work for the whole-graph timeout in server.ts — it
// doesn't depend on any internal plumbing honoring anything, it just stops
// waiting at the deadline. Same caveat as that one: the underlying call
// isn't cancelled, just abandoned, so it can keep running in the background
// after this rejects.
const LLM_CALL_TIMEOUT_MS = 150_000;

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`LLM call exceeded ${ms / 1000}s timeout.`)), ms).unref();
    }),
  ]);
}

export function isRetryableError(error: unknown): boolean {
  const err = error as { status?: number; lc_error_code?: string; message?: string; name?: string } | undefined;
  if (!err) return false;
  if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503) return true;
  if (err.lc_error_code === 'MODEL_RATE_LIMIT') return true;
  // The timeout below aborts via AbortSignal.timeout(), which surfaces as an
  // AbortError/TimeoutError by name — the message text isn't guaranteed to
  // contain the word "timeout" (depends on how the underlying fetch/SDK
  // wraps it), so check the name explicitly rather than relying on the
  // message regex below to catch it.
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
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
      // No explicit cap originally — fell back to whatever default the
      // provider/model applies, which truncated the Reviewer's postText
      // mid-sentence on a real run. Set to 4096 first, but that ALSO
      // truncated on a later run — deepseek-v4-flash-0731 supports
      // "reasoning"/"reasoning_effort" (it's a reasoning model), and hidden
      // reasoning tokens count against the same maxTokens budget as the
      // final answer. The OpenAI SDK's own parser throws "Could not parse
      // response content as the length limit was reached" when that budget
      // runs out before a complete JSON response is written — confirmed via
      // a real stack trace. The model's actual max_completion_tokens ceiling
      // is 393,216 (verified against OpenRouter's models API), so there's
      // enormous headroom to raise this without approaching a real limit.
      maxTokens: 24_576,
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
        // OpenRouter's unified reasoning parameter — deepseek-v4-flash-0731
        // (and gpt-5.6-luna) both advertise "reasoning"/"reasoning_effort"
        // in their supported_parameters, meaning they can silently spend a
        // chunk of the token budget "thinking" before writing the actual
        // structured JSON answer. None of this app's tasks (classify a
        // niche, fact-check a draft against fixed rules, write technical
        // prose from provided sources) need deep multi-step reasoning —
        // 'low' trims that hidden latency/token cost while keeping some
        // headroom, rather than 'none', which removes it entirely and risks
        // hurting the Reviewer's actual fact-checking judgment.
        reasoning: { effort: 'low' },
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
        const data = await raceWithTimeout(agent.invoke({ messages }), LLM_CALL_TIMEOUT_MS);
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
