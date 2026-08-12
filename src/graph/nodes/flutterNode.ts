import type { Runtime } from '@langchain/langgraph';
import { OpenRouterService } from '../../services/openrouterService.ts';
import { ragService } from '../../services/ragService.ts';
import type { GraphState } from '../graph.ts';
import { SpecialistOutputSchema } from './schemas.ts';
import { extractUrls, fetchUrlContent } from '../../services/webContentService.ts';

export function createIosNode(llmClient: OpenRouterService) {
  return async (state: GraphState, runtime?: Runtime): Promise<Partial<GraphState>> => {
    console.log("[iOS Specialist] Collecting RAG and generating draft...");

    let ragContext = await ragService.retrieveContext(state.initialCommand, "ios");

    if (state.reviewCount > 0 && state.reviewerSearchQuery) {
      console.log(`[Iterative RAG] Searching Pinecone context for: "${state.reviewerSearchQuery}"...`);
      const correctiveContext = await ragService.retrieveContext(state.reviewerSearchQuery, "ios");
      if (correctiveContext) {
        ragContext = `${ragContext}\n\n[RAG Data (Correction)]: \n${correctiveContext}`;
      }
    }

    // --- Live URL Content Extraction ---
    const urls = extractUrls(state.initialCommand);
    let webData = '';
    if (urls.length > 0) {
      console.log(`[URL Extractor] Found ${urls.length} URL(s) in command. Fetching live content...`);
      const fetchResults = await Promise.allSettled(urls.map(url => fetchUrlContent(url)));
      const fetchedContents: string[] = [];

      fetchResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          console.log(`[URL Extractor] ✅ Fetched: ${urls[idx]}`);
          fetchedContents.push(`[Source: ${urls[idx]}]\n${result.value}`);
        } else {
          console.warn(`[URL Extractor] ❌ Could not fetch: ${urls[idx]}`);
        }
      });

      if (fetchedContents.length > 0) {
        webData = fetchedContents.join('\n\n---\n\n');
      }
    }

    const systemPrompt = `You are a Senior iOS Engineer specializing in Swift and Apple's native app platform (SwiftUI, UIKit, Combine, Swift Concurrency).
Persona: Pragmatic executor, over 6 years experience. PROHIBITED: Never use "Tech Lead" or management titles. Avoid hype words.

CODE & IMAGE INFERENCE (CRITICAL):
- Carefully analyze the user prompt ("Topic") to infer whether code examples are needed:
  * IF THE PROMPT EXPLICITLY OR IMPLICITLY DEMANDS CODE (e.g. mentions "code examples", "how to write", "create code", "show implementation", "with code", "example of", or if the topic intrinsically requires a code snippet to be practical and useful for developers):
    1. DO NOT output raw markdown code blocks in the text draft. Replace code with [CODE_SNIPPET_1], [CODE_SNIPPET_2], etc. inside the text draft.
    2. Provide the complete, compilable, raw Swift source code in the 'codeSnippets' array matching each placeholder.
  * IF THE PROMPT IS CONCEPTUAL, ARCHITECTURAL, HIGH-LEVEL, OR ASKS FOR TEXT-ONLY (or if code snippets would be forced, trivial, or unnecessary):
    1. Write a compelling, technical text-only draft. DO NOT include any [CODE_SNIPPET_X] placeholders in the text draft.
    2. Set 'codeSnippets' to an empty array ([]).

STRICT GROUNDING & ANTI-HALLUCINATION:
1. Ground your knowledge in the provided data sources ([WEB_DATA], [RAG Data]). These override your internal training data.
2. Never invent APIs, methods, framework/SDK versions, or parameters. If uncertain about a version number, use general phrasing (e.g., "In recent versions of iOS...") instead of guessing.
3. All code snippets in 'codeSnippets' must be complete, syntactically valid Swift code. Do not use unresolved ellipses (...) or undefined placeholders inside code blocks. Code must be clean, readable, and directly copy-pasteable.

KNOWLEDGE CUTOFF AWARENESS (CRITICAL):
4. Your training data has a cutoff date. You may be unaware of recent releases, announcements, or ecosystem changes. NEVER assume something does not exist just because you have no knowledge of it.
5. If [WEB_DATA] is present, it contains LIVE content fetched from URLs the user provided. This data is absolute ground truth. Base the post primarily on [WEB_DATA] and make this explicit: reference what the source says rather than speculating.
6. If [WEB_DATA] contradicts your internal knowledge (e.g., a version or feature exists that you thought didn't), ALWAYS trust [WEB_DATA]. Clearly attribute claims to the source.
7. If no [WEB_DATA] is available and the topic involves a recent release or announcement you cannot confidently confirm from training, explicitly write in the draft: "[FACT-CHECK REQUIRED: This information is based on training data and may be outdated. Please verify against the official source.]"

VERBATIM CITATION FOR TECHNICAL SPECIFICS (CRITICAL):
8. For CLI/build flags (e.g. xcodebuild, Swift Package Manager flags), package names, installation commands, and hyperlinks/URLs: copy them VERBATIM from [WEB_DATA]. Never paraphrase, rename, or invent them. If the exact name or URL is not explicitly present in [WEB_DATA], DO NOT include it — use general phrasing instead.
9. For benchmark numbers (e.g., build times, frame rates, memory footprint): cite only numbers that appear explicitly in [WEB_DATA]. Do not round, interpolate, or extrapolate values.
10. If [WEB_DATA] content appears noisy, truncated, or HTML-heavy, extract only the article body paragraphs. If you cannot confidently identify what the source claims about a specific technical detail, omit that detail rather than guessing.`;

    let userPrompt = `Topic:\n"${state.initialCommand}"\n\n`;
    if (webData) {
      userPrompt += `[WEB_DATA] (live content fetched from URLs in the command — treat as absolute ground truth, prioritize over all other sources):\n${webData}\n\n`;
    }
    if (ragContext) userPrompt += `[RAG Data]:\n${ragContext}\n\n`;
    if (state.mcpContext) userPrompt += `[MCP Data]:\n${state.mcpContext}\n\n`;

    if (state.reviewCount > 0 && state.reviewFeedback) {
      const hasSurgical = state.approvedContent || (state.corrections && state.corrections.length > 0);

      if (hasSurgical) {
        userPrompt += `[SURGICAL CORRECTION MODE — Attempt ${state.reviewCount + 1}]:
The reviewer has identified SPECIFIC errors in the previous draft. Your task is to:
1. Preserve ALL of the [APPROVED CONTENT] below VERBATIM — do not alter a single word, punctuation mark, or line break.
2. Apply ONLY the corrections listed in [CORRECTIONS NEEDED] — nothing more.
3. Reassemble the final complete draft by integrating the corrections into the approved content.
4. Do NOT introduce any new claims, examples, or code snippets beyond what is in the approved content + corrections.
5. [PREVIOUS CODE SNIPPETS] below is the actual Swift code you wrote last attempt. If any correction or the general feedback references an API, method, or claim that appears INSIDE that code (e.g. a hallucinated function that doesn't exist), you MUST also fix the corresponding entry in your new 'codeSnippets' output to use the real API — do not just patch the prose while leaving the code itself wrong. If the code was not flagged, keep it unchanged.

[APPROVED CONTENT — COPY VERBATIM, NO CHANGES]:
${state.approvedContent || '(none — the reviewer did not identify any fully correct sections)'}

[PREVIOUS CODE SNIPPETS — FIX ONLY IF REFERENCED BY A CORRECTION OR THE FEEDBACK BELOW]:
${state.codeSnippets && state.codeSnippets.length > 0 ? state.codeSnippets.join('\n\n---\n\n') : '(none)'}

[CORRECTIONS NEEDED — APPLY THESE SURGICAL FIXES]:
${state.corrections && state.corrections.length > 0
  ? state.corrections.map((c, i) =>
    `Fix #${i + 1}:\n  - ORIGINAL (wrong): "${c.originalText}"\n  - ISSUE: ${c.issue}\n  - REPLACE WITH: ${c.suggestedReplacement || '(delete this claim entirely)'}`
  ).join('\n\n')
  : '(no specific corrections listed — use the general feedback below)'}

[GENERAL FEEDBACK FOR CONTEXT]:
"${state.reviewFeedback}"

`;
      } else {
        userPrompt += `[REVIEW FEEDBACK — FULL REWRITE NEEDED]:\n"${state.reviewFeedback}"\n\n`;
      }
    }

    const result = await llmClient.generateStructured(systemPrompt, userPrompt, SpecialistOutputSchema);

    if (!result.success || !result.data) throw new Error(`Failed to generate iOS draft: ${result.error || 'unknown error'}`);

    return {
      ragContext: ragContext,
      webData: webData || undefined,
      technicalDraft: result.data.technicalDraft,
      codeSnippets: result.data.codeSnippets,
    };
  };
}
