import type { Runtime } from '@langchain/langgraph';
import { OpenRouterService } from '../../services/openrouterService.ts';
import type { GraphState } from '../graph.ts';
import { ReviewerOutputSchema } from './schemas.ts';
import { MAX_REVIEW_ATTEMPTS } from './edgeConditions.ts';

// Sometimes the specialist LLM echoes the "[CODE_SNIPPET_N]" placeholder
// token itself (or leaves it empty) as the actual codeSnippets[N-1] value,
// instead of writing real code. imageExtractorNode then strips the
// placeholder prefix, is left with an empty string, and silently skips
// image generation — so the post gets published with no code image and
// nobody notices. This is a mechanical, deterministic failure (not a
// judgement call), so we catch it with a regex instead of hoping the LLM
// reviewer notices it in the middle of a long code review.
const EMPTY_OR_PLACEHOLDER_ONLY_RE = /^\[CODE_SNIPPET_\d+\]:?\s*$/i;
const PLACEHOLDER_PREFIX_RE = /^\[CODE_SNIPPET_\d+\]:?\s*/i;

// Exported so src/scripts/run-eval.ts can reuse the exact same check as a
// deterministic evaluator instead of duplicating the regex.
export function findBrokenCodeSnippets(codeSnippets?: string[]): number[] {
  if (!codeSnippets || codeSnippets.length === 0) return [];
  const broken: number[] = [];
  codeSnippets.forEach((snippet, i) => {
    const trimmed = (snippet ?? '').trim();
    const strippedOfPrefix = trimmed.replace(PLACEHOLDER_PREFIX_RE, '').trim();
    if (!strippedOfPrefix || EMPTY_OR_PLACEHOLDER_ONLY_RE.test(trimmed)) {
      broken.push(i + 1); // 1-indexed to match [CODE_SNIPPET_N] naming
    }
  });
  return broken;
}

export function createReviewerNode(llmClient: OpenRouterService) {
  return async (state: GraphState, runtime?: Runtime): Promise<Partial<GraphState>> => {
    // Defensive fallback: reviewCount should always be seeded to 0 by the
    // state schema's default, but a corrupted execution context (e.g. two
    // tracers fighting over the same AsyncLocalStorage run tree — see
    // run-eval.ts for a real case of this) can occasionally hand us
    // `undefined` here. Guard against `undefined + 1 = NaN` blowing up the
    // graph's state validation.
    const reviewCount = state.reviewCount ?? 0;
    console.log(`[Reviewer] Auditing draft (Attempt ${reviewCount + 1}/${MAX_REVIEW_ATTEMPTS})...`);

    // Defensive short-circuit: routeAfterReview already stops the loop once
    // reviewCount hits MAX_REVIEW_ATTEMPTS and sends the state straight to
    // imageExtractor, so this node normally never runs again at/after the cap.
    // This guard only matters if the node is invoked directly (e.g. graph
    // resumed from a checkpoint at the limit) — skip the LLM call and let
    // imageExtractorNode decide whether the draft is salvageable.
    if (reviewCount >= MAX_REVIEW_ATTEMPTS) {
      return { reviewFeedback: '' };
    }

    const brokenSnippets = findBrokenCodeSnippets(state.codeSnippets);
    if (brokenSnippets.length > 0) {
      console.warn(`[Reviewer] ⚠️  Deterministic check: codeSnippets [${brokenSnippets.join(', ')}] are empty or placeholder-only (specialist echoed the token instead of writing code). Forcing a corrective retry without an LLM call.`);
      const list = brokenSnippets.map((n) => `codeSnippets[${n - 1}]`).join(', ');
      // Structured 'corrections' entries (not just prose in reviewFeedback) so
      // this rides the same explicit "Fix #N" list the specialist already
      // follows for factual corrections — weaker fallback models are more
      // likely to act on a numbered instruction than on prose buried in
      // general feedback.
      const corrections = brokenSnippets.map((n) => ({
        originalText: `[CODE_SNIPPET_${n}]`,
        issue: `codeSnippets[${n - 1}] was left empty or as the literal placeholder token instead of real code — this is NOT something to preserve, it's a failure from last attempt.`,
        suggestedReplacement: `(write complete, compilable code here — do not copy the placeholder token forward)`,
      }));
      return {
        reviewFeedback: `Snippet(s) #${brokenSnippets.join(', #')} were left as empty placeholders instead of real code — you output the literal "[CODE_SNIPPET_N]" token (or nothing) as the codeSnippets entry instead of actual source. In your next 'codeSnippets' array, you MUST replace ${list} with complete, compilable code implementing what the draft describes for that snippet. Every codeSnippets entry must contain real code, never the placeholder token or an empty string.`,
        reviewerSearchQuery: '',
        approvedContent: state.technicalDraft || undefined,
        corrections,
        reviewCount: reviewCount + 1,
      };
    }

    const systemPrompt = `You are an Expert LinkedIn SSI Strategist. Format technical drafts for max engagement.
Persona: Full Stack Engineer (Mobile/Backend/AI Student). NO "Tech Lead" titles.
Rules: Flawless US English. No AI jargon. Max 2-3 lines per paragraph. If code placeholders ([CODE_SNIPPET_1], [CODE_SNIPPET_2], etc.) are present, replace them with [IMAGE_CODE_1], [IMAGE_CODE_2], etc. in the final post text. If the draft is text-only (no code placeholders), output clean text without inserting fake code placeholders. End with a technical question.

STRICT TECHNICAL FACT-CHECKING & CODE REVIEW:
1. Act as a strict technical fact-checker. Verify all version numbers, API designs, library names, and architectural claims in the draft.
2. If the draft contains fabricated, outdated, or incorrect version claims (e.g. claiming a feature was introduced in iOS 16 when it was iOS 17), or references non-existent APIs, you MUST reject the post (set isApproved to false) and describe the error clearly in the 'feedback' property so the specialist can correct it.
3. If a [CODE SNIPPETS] section is provided below, it contains the ACTUAL raw code referenced by [CODE_SNIPPET_N] placeholders in the draft — this is the real code that will be rendered as an image and published, not the placeholder text. You MUST scrutinize it line by line for: (a) hallucinated/non-existent APIs, methods, or functions that do not exist in the real language/framework, (b) invalid placeholders like 'child: ...' or unresolved ellipsis that make the code uncompilable, (c) syntax errors. Reject the post if any of these are present, and reference the exact offending API/line in 'feedback' and in a 'corrections' entry (with 'originalText' being the wrong code line/API name). If no [CODE SNIPPETS] section is provided (text-only draft), skip code validation — do NOT reject a post simply because it is text-only, unless the user prompt strictly demanded code examples.
4. Ensure the final post text does not contain raw markdown code blocks (code should be represented as [IMAGE_CODE_X] if image code snippets were provided, or kept as plain text if no code snippets were generated).
5. KNOWLEDGE CUTOFF CHECK: If the draft denies the existence of something the user explicitly asked about (e.g., "this version does not exist", "this feature was not announced"), this is a critical hallucination and MUST be rejected with a clear explanation in the feedback field. The specialist's training data may simply be outdated — refusal to engage with valid user topics is always wrong.
6. [WEB_DATA] VALIDATION: If [WEB_DATA] is provided below, it contains live content fetched from the user's source URL. Use it as ground truth when fact-checking. A claim in the draft is VALID if it appears in [WEB_DATA], even if it contradicts your training. Do NOT reject a claim solely because it conflicts with your training data if [WEB_DATA] supports it.

SURGICAL CORRECTION OUTPUT (when isApproved is false):
7. Populate 'approvedContent' with ALL text from the draft that is factually correct and well-written — copy it VERBATIM, sentence by sentence. This text will be reused directly in the next iteration without regeneration. The more you preserve, the less the specialist needs to rewrite.
8. Populate 'corrections' with a list of surgical fixes. Each item must have:
   - 'originalText': the EXACT wrong sentence or claim, copy-pasted from the draft (so it can be located with string search).
   - 'issue': one sentence explaining why it is wrong.
   - 'suggestedReplacement': the corrected version, or an empty string if the claim should be deleted entirely.
9. Do NOT put entire paragraphs in 'corrections' if only one sentence is wrong. Isolate the minimum broken unit (a claim, a flag name, a URL, a number).`;

    const today = new Date().toISOString().split('T')[0]; // e.g. "2026-07-14"
    let userPrompt = `CONTEXT FOR THIS REVIEW:
Today's date is ${today}. The specialist may have written about topics that are more recent than your training data cutoff. This is expected and valid.
If [WEB_DATA] is provided below and confirms the facts in the draft, treat those facts as VERIFIED — do not reject them solely because they postdate your knowledge cutoff.
Your job is to check that the draft accurately reflects what [WEB_DATA] says, not to question whether [WEB_DATA] itself is real.

---

Review this draft:\n\n${state.technicalDraft}`;
    if (state.codeSnippets && state.codeSnippets.length > 0) {
      userPrompt += `\n\n[CODE SNIPPETS] (the actual raw code behind each [CODE_SNIPPET_N] placeholder above — this is what gets published, validate it for real, non-hallucinated APIs):\n\n${state.codeSnippets.join('\n\n---\n\n')}`;
    }
    if (state.webData) {
      userPrompt += `\n\n[WEB_DATA] (live source fetched from the user's URL — use as ground truth for fact-checking):\n${state.webData.substring(0, 6_000)}`;
    }
    const result = await llmClient.generateStructured(systemPrompt, userPrompt, ReviewerOutputSchema);

    if (!result.success || !result.data) {
      console.warn(`[Reviewer] Error analyzing draft: ${result.error || 'no data'}. Incrementing reviewCount.`);
      return {
        reviewFeedback: "System error during review, retry.",
        reviewerSearchQuery: "",
        reviewCount: reviewCount + 1,
      };
    }

    if (!result.data.isApproved) {
      const hasSurgicalData = result.data.approvedContent || (result.data.corrections && result.data.corrections.length > 0);
      console.log(`[Reviewer] Rejected. Reason: ${result.data.feedback} | Surgical corrections: ${result.data.corrections?.length ?? 0} | Approved content preserved: ${result.data.approvedContent ? 'yes' : 'no'} | Suggested RAG Query: ${result.data.reviewerSearchQuery}`);
      return {
        reviewFeedback: result.data.feedback,
        reviewerSearchQuery: result.data.reviewerSearchQuery,
        approvedContent: result.data.approvedContent || undefined,
        corrections: result.data.corrections && result.data.corrections.length > 0 ? result.data.corrections : undefined,
        reviewCount: reviewCount + 1,
      };
    }

    console.log("[Reviewer] Draft Approved!");
    return {
      reviewFeedback: "",
      reviewerSearchQuery: "",
      finalPostText: result.data.postText,
      hashtags: result.data.hashtags,
    };
  };
}
