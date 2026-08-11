import type { Runtime } from '@langchain/langgraph';
import { OpenRouterService } from '../../services/openrouterService.ts';
import type { GraphState } from '../graph.ts';
import { OrchestratorOutputSchema } from './schemas.ts';

export function createOrchestratorNode(llmClient: OpenRouterService) {
  return async (state: GraphState, runtime?: Runtime): Promise<Partial<GraphState>> => {
    console.log(`\n[Orchestrator] Analyzing: "${state.initialCommand}"`);

    const systemPrompt = `You are a Technical Dispatcher for an automated LinkedIn content creation system. Classify the user's command into one of the following niches:
- "ios": For native iOS/Apple platform development — Swift, SwiftUI, UIKit, Xcode, Combine, Swift Concurrency, and the broader Apple ecosystem (watchOS, iPadOS, macOS when framed as iOS-adjacent).
- "node_react": For JavaScript/TypeScript ecosystem, Node.js backend, React frontend, Next.js, and general web development topics.
- "ai_engineering": For Artificial Intelligence, Machine Learning, LLMs, RAG architectures, and agentic workflows (like LangGraph).
- "out_of_scope": For topics that are completely unrelated to software engineering, programming, or the technical niches listed above (e.g., jokes, recipes, general chatting, news, etc.).

Focus on the core technical and architectural intent of the user's command.
Also, create a very short, succinct folder name (slug) in lowercase with hyphens representing the topic, limited to a maximum of 20 characters (e.g. 'ios-swiftui', 'next-auth', 'langgraph-ai').`;
    const userPrompt = `Classify this request:\n\n"${state.initialCommand}"`;

    const result = await llmClient.generateStructured(systemPrompt, userPrompt, OrchestratorOutputSchema);

    if (!result.success || !result.data) {
      console.warn(`[Orchestrator] Fallback activated. Error: ${result.error}`);
      return { niche: "node_react", suggestedFolderSlug: "node-react" }; 
    }

    console.log(`[Orchestrator] Niche: ${result.data.niche} | Suggested Slug: ${result.data.suggestedFolderSlug} | Reason: ${result.data.reasoning}`);
    return { 
      niche: result.data.niche,
      suggestedFolderSlug: result.data.suggestedFolderSlug,
    };
  };
}
