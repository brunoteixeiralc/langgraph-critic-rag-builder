import type { GraphState } from '../graph.ts';

// Single source of truth for the review-loop cap. reviewerNode.ts and
// imageExtractorNode.ts import this instead of hardcoding their own number.
export const MAX_REVIEW_ATTEMPTS = 3;

export const routeToSpecialist = (state: GraphState): string => {
  if (!state.niche) return 'nodeReactSpecialist';

  const routes: Record<string, string> = {
    flutter_dart: 'flutterSpecialist',
    node_react: 'nodeReactSpecialist',
    ai_engineering: 'aiSpecialist',
    out_of_scope: 'imageExtractor',
  };

  return routes[state.niche] || 'nodeReactSpecialist';
};

export const routeAfterReview = (state: GraphState): string => {
  if (!state.reviewFeedback || state.reviewFeedback.trim() === "") {
    return 'imageExtractor';
  }
  if (state.reviewCount >= MAX_REVIEW_ATTEMPTS) {
    console.warn("⚠️ Review limit reached. Proceeding to extraction.");
    return 'imageExtractor';
  }
  return routeToSpecialist(state);
};
