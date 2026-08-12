/**
 * LangSmith evaluation dataset setup.
 *
 * Creates (or updates) a LangSmith dataset of reference topics — one per
 * niche, plus an out-of-scope case — with the expected classification and
 * whether code snippets are required. This is the "ground truth" that
 * src/scripts/run-eval.ts checks the live graph against.
 *
 * The topics below are the exact prompts we already used for manual testing
 * throughout development (see tests/orchestrator.test.ts) — this just makes
 * that ad-hoc testing repeatable and trackable over time in LangSmith.
 *
 * Safe to re-run: skips any topic that's already in the dataset instead of
 * creating duplicates.
 *
 * Usage:
 *   npm run eval:setup
 *
 * Requires LANGSMITH_API_KEY in .env.
 */
import { Client } from 'langsmith';

const DATASET_NAME = 'linkedin-post-generator-niches';

type ExampleDef = {
  topic: string;
  expectedNiche: 'ios' | 'node_react' | 'ai_engineering' | 'out_of_scope';
  expectsCode: boolean; // whether the topic explicitly demands code examples
};

const EXAMPLES: ExampleDef[] = [
  { topic: 'Explain how Swift async/await works, with code examples', expectedNiche: 'ios', expectsCode: true },
  { topic: 'Explain dependency injection in iOS using Swift property wrappers', expectedNiche: 'ios', expectsCode: false },
  { topic: 'Explain Node.js event loop with code examples and how it handles concurrency', expectedNiche: 'node_react', expectsCode: true },
  { topic: 'Show how to build a multi-agent system using LangGraph and Gemini', expectedNiche: 'ai_engineering', expectsCode: false },
  { topic: 'Quero uma receita de bolo de cenoura com calda de chocolate', expectedNiche: 'out_of_scope', expectsCode: false },
];

async function main() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error('❌ LANGSMITH_API_KEY not set in .env. Aborting.');
    process.exit(1);
  }

  const client = new Client();

  const alreadyExists = await client.hasDataset({ datasetName: DATASET_NAME }).catch(() => false);
  const dataset = alreadyExists
    ? await client.readDataset({ datasetName: DATASET_NAME })
    : await client.createDataset(DATASET_NAME, {
        description:
          'Reference topics for langgraph-critic-rag-builder: expected niche classification and whether code snippets are required. Consumed by src/scripts/run-eval.ts.',
      });

  console.log(alreadyExists ? `[Eval] Using existing dataset "${DATASET_NAME}" (${dataset.id}).` : `[Eval] Created dataset "${DATASET_NAME}" (${dataset.id}).`);

  const existingTopics = new Set<string>();
  for await (const example of client.listExamples({ datasetId: dataset.id })) {
    const topic = example.inputs?.topic;
    if (typeof topic === 'string') existingTopics.add(topic);
  }

  const toCreate = EXAMPLES.filter((e) => !existingTopics.has(e.topic));
  if (toCreate.length === 0) {
    console.log('[Eval] All reference examples are already present. Nothing to add.');
    return;
  }

  await client.createExamples(
    toCreate.map((e) => ({
      dataset_id: dataset.id,
      inputs: { topic: e.topic },
      outputs: { expectedNiche: e.expectedNiche, expectsCode: e.expectsCode },
    })),
  );

  console.log(`[Eval] Added ${toCreate.length} example(s) (${toCreate.map((e) => `"${e.topic.slice(0, 40)}..."`).join(', ')}).`);
  console.log(`[Eval] Skipped ${EXAMPLES.length - toCreate.length} already-present example(s).`);
  console.log('\nDone. Run `npm run eval` to evaluate the graph against this dataset.');
}

main().catch((err) => {
  console.error('❌ Failed to set up eval dataset:', err);
  process.exit(1);
});
