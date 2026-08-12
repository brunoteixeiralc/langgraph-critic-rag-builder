/**
 * LangSmith evaluation runner.
 *
 * Runs the actual multi-agent graph (Orchestrator → specialist → Reviewer
 * loop → Image Extractor) against every example in the
 * "linkedin-post-generator-niches" dataset (see create-eval-dataset.ts) and
 * scores each run with deterministic evaluators — no LLM-as-judge involved,
 * so results are reproducible and don't burn extra tokens:
 *
 *   - niche_correct:        did the Orchestrator classify the topic as expected?
 *   - approved:              did the Reviewer approve the post (within
 *                            MAX_REVIEW_ATTEMPTS)? Skipped for out_of_scope
 *                            examples, which never reach the Reviewer.
 *   - code_snippets_valid:   when code is expected, are the codeSnippets
 *                            real code — not empty or a leftover
 *                            "[CODE_SNIPPET_N]" placeholder (the exact bug
 *                            we chased and fixed in reviewerNode.ts)?
 *   - review_attempts:       informational metric, not pass/fail — how many
 *                            review cycles it took to land on an approved
 *                            (or exhausted) result.
 *
 * This actually runs the graph for real, so it costs real LLM + embedding
 * calls (same as a normal /generate request) — keep the dataset small and
 * run with modest concurrency to stay inside free-tier rate limits.
 *
 * Usage:
 *   npm run eval
 *
 * Requires the same env vars as the running app (PINECONE_*, GEMINI_*,
 * OPENROUTER_API_KEY) plus LANGSMITH_API_KEY. Results show up as a new
 * "experiment" on the dataset in the LangSmith UI.
 */
import { evaluate } from 'langsmith/evaluation';
import type { EvaluationResult } from 'langsmith/evaluation';
import { OpenRouterService } from '../services/openrouterService.ts';
import { buildPostGraph } from '../graph/graph.ts';
import { findBrokenCodeSnippets } from '../graph/nodes/reviewerNode.ts';

const DATASET_NAME = 'linkedin-post-generator-niches';

type ReferenceOutputs = {
  expectedNiche: 'ios' | 'node_react' | 'ai_engineering' | 'out_of_scope';
  expectsCode: boolean;
};

type TargetOutputs = {
  niche: string | null;
  approved: boolean;
  reviewCount: number;
  codeSnippets: string[];
};

async function target(input: { topic: string }): Promise<TargetOutputs> {
  const llmClient = new OpenRouterService();
  const graph = buildPostGraph(llmClient);
  const result = await graph.invoke({ initialCommand: input.topic });

  return {
    niche: result.niche ?? null,
    approved: Boolean(result.finalPostText), // same rule src/server.ts uses
    reviewCount: result.reviewCount ?? 0,
    codeSnippets: result.codeSnippets ?? [],
  };
}

// NOTE on the loose `Record<string, any>` param types below: langsmith's
// `EvaluatorT` is a union that also includes a deprecated `(run, example)`
// 2-positional-arg signature. TypeScript checks a single-object-param
// function against that union structurally, and if any field here is typed
// as *required*, it fails to match the deprecated arm (whose `run` object
// doesn't have e.g. 'referenceOutputs') and the whole union assignment
// breaks with a confusing "No overload matches" error. Keeping every field
// optional and casting internally sidesteps that — the library still calls
// these with the real single merged object at runtime regardless of which
// TS arm typechecked.
type EvalArgs = { outputs?: Record<string, any>; referenceOutputs?: Record<string, any> };

function nicheCorrect({ outputs, referenceOutputs }: EvalArgs): EvaluationResult {
  const out = outputs as TargetOutputs | undefined;
  const ref = referenceOutputs as ReferenceOutputs | undefined;
  return {
    key: 'niche_correct',
    score: out?.niche === ref?.expectedNiche ? 1 : 0,
    comment: `expected "${ref?.expectedNiche}", got "${out?.niche}"`,
  };
}

function approved({ outputs, referenceOutputs }: EvalArgs): EvaluationResult {
  const out = outputs as TargetOutputs | undefined;
  const ref = referenceOutputs as ReferenceOutputs | undefined;
  // out_of_scope topics never reach the Reviewer (imageExtractor writes an
  // error report instead), so "approved" isn't a meaningful check there.
  if (ref?.expectedNiche === 'out_of_scope') {
    return { key: 'approved', score: 1, comment: 'skipped — out_of_scope never reaches the Reviewer' };
  }
  return {
    key: 'approved',
    score: out?.approved ? 1 : 0,
    comment: out?.approved ? undefined : `not approved after ${out?.reviewCount ?? '?'} review attempt(s)`,
  };
}

function codeSnippetsValid({ outputs, referenceOutputs }: EvalArgs): EvaluationResult {
  const out = outputs as TargetOutputs | undefined;
  const ref = referenceOutputs as ReferenceOutputs | undefined;
  if (!ref?.expectsCode) {
    return { key: 'code_snippets_valid', score: 1, comment: 'skipped — this topic does not require code' };
  }
  const snippets = out?.codeSnippets ?? [];
  const hasSnippets = snippets.length > 0;
  const broken = findBrokenCodeSnippets(snippets);
  return {
    key: 'code_snippets_valid',
    score: hasSnippets && broken.length === 0 ? 1 : 0,
    comment: !hasSnippets
      ? 'expected code but codeSnippets was empty'
      : broken.length > 0
        ? `snippet(s) #${broken.join(', #')} are empty/placeholder-only`
        : undefined,
  };
}

function reviewAttempts({ outputs }: EvalArgs): EvaluationResult {
  const out = outputs as TargetOutputs | undefined;
  // Informational only — not a pass/fail check, just a metric to watch over
  // time (a creeping average suggests the RAG context or prompts drifted).
  return { key: 'review_attempts', score: out?.reviewCount ?? 0 };
}

async function main() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error('❌ LANGSMITH_API_KEY not set in .env. Aborting.');
    process.exit(1);
  }
  if (!process.env.PINECONE_API_KEY || !process.env.GEMINI_API_KEY || !process.env.OPENROUTER_API_KEY) {
    console.error('❌ Missing PINECONE_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY in .env. Aborting.');
    process.exit(1);
  }

  console.log(`[Eval] Running the graph against dataset "${DATASET_NAME}"... this makes real LLM/embedding calls, same cost as normal /generate requests.`);

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [nicheCorrect, approved, codeSnippetsValid, reviewAttempts],
    experimentPrefix: 'linkedin-post-gen',
    maxConcurrency: 1, // gentle on free-tier rate limits (Gemini embeddings, OpenRouter)
  });

  // The SDK already prints a direct experiment URL to the console during the
  // run above; this is just a pointer to where to find it in the UI afterward.
  console.log(`\n✅ Evaluation complete. Experiment "${results.experimentName}" — view it in LangSmith under Datasets → "${DATASET_NAME}" → Experiments.`);
}

main().catch((err) => {
  console.error('❌ Evaluation run failed:', err);
  process.exit(1);
});
