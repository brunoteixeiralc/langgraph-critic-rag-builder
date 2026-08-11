import { StateGraph, START, END } from "@langchain/langgraph";
import { z } from "zod/v3";
import { OpenRouterService } from '../services/openrouterService.ts';

import { createOrchestratorNode } from './nodes/orchestratorNode.ts';
import { createIosNode } from './nodes/flutterNode.ts'; // filename kept as flutterNode.ts — rename to iosNode.ts locally if you want, imports don't need file renames to work
import { createReviewerNode } from './nodes/reviewerNode.ts';
import { createImageExtractorNode } from './nodes/imageExtractorNode.ts';
import { routeToSpecialist, routeAfterReview } from './nodes/edgeConditions.ts';
import { createNodeReactNode } from "./nodes/nodeJsReactNode.ts";
import { createAiNode } from "./nodes/aiNode.ts";

export const PostStateAnnotation = z.object({
  initialCommand: z.string(),
  niche: z.enum(["ios", "node_react", "ai_engineering", "out_of_scope"]).optional(),
  suggestedFolderSlug: z.string().optional(),
  reviewerSearchQuery: z.string().optional(),
  ragContext: z.string().optional(),
  webData: z.string().optional(),        // Live content fetched from URLs in the user command
  mcpContext: z.string().optional(),
  technicalDraft: z.string().optional(),
  codeSnippets: z.array(z.string()).optional(),
  reviewFeedback: z.string().optional(),
  // Surgical correction fields — populated by the Reviewer on rejection
  approvedContent: z.string().optional(),     // Verbatim correct sections to preserve
  corrections: z.array(z.object({             // Structured list of wrong claims + fixes
    originalText: z.string(),
    issue: z.string(),
    suggestedReplacement: z.string(),
  })).optional(),
  finalPostText: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  reviewCount: z.number().default(0),
  // Populated by imageExtractorNode with the rendered Carbonara PNGs
  // (base64-encoded) alongside writing them to disk. Consumers that can't
  // rely on the local filesystem persisting (e.g. an HTTP wrapper deployed
  // to an ephemeral container) can read the images straight from state.
  codeImages: z.array(z.object({
    index: z.number(),
    filename: z.string(),
    base64: z.string(),
  })).optional(),
});

export type GraphState = z.infer<typeof PostStateAnnotation>;

export function buildPostGraph(llmClient: OpenRouterService) {
  const graph = new StateGraph(PostStateAnnotation)
    .addNode('orchestrator', createOrchestratorNode(llmClient))
    .addNode('iosSpecialist', createIosNode(llmClient))
    .addNode('nodeReactSpecialist', createNodeReactNode(llmClient))
    .addNode('aiSpecialist', createAiNode(llmClient))
    .addNode('reviewer', createReviewerNode(llmClient))
    .addNode('imageExtractor', createImageExtractorNode())

    .addEdge(START, 'orchestrator')
    .addConditionalEdges('orchestrator', routeToSpecialist, {
      iosSpecialist: 'iosSpecialist',
      nodeReactSpecialist: 'nodeReactSpecialist',
      aiSpecialist: 'aiSpecialist',
      imageExtractor: 'imageExtractor',
    })

    .addEdge('iosSpecialist', 'reviewer')
    .addEdge('nodeReactSpecialist', 'reviewer')
    .addEdge('aiSpecialist', 'reviewer')

    .addConditionalEdges('reviewer', routeAfterReview, {
      imageExtractor: 'imageExtractor',
      iosSpecialist: 'iosSpecialist',
      nodeReactSpecialist: 'nodeReactSpecialist',
      aiSpecialist: 'aiSpecialist',
    })
    .addEdge('imageExtractor', END);

  return graph.compile();
}
