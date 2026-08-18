import fs from 'fs/promises';
import path from 'path';
import type { Runtime } from '@langchain/langgraph';
import type { GraphState } from '../graph.ts';
import { MAX_REVIEW_ATTEMPTS } from './edgeConditions.ts';

// Minimum length for a technicalDraft to be considered salvageable when the
// review loop is cut off at MAX_REVIEW_ATTEMPTS without approval.
const MIN_SALVAGEABLE_DRAFT_LENGTH = 100;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function getExtension(niche?: string, code?: string): string {
  if (niche === 'ios') return 'swift';
  if (niche === 'ai_engineering') {
    if (code && (code.includes('import ') || code.includes('def ') || code.includes('print(')) && !code.includes('console.log')) {
      return 'py';
    }
    return 'ts';
  }
  return 'ts';
}

// Runs fn over items with at most `limit` in flight at once, preserving
// result order. Sits between "one at a time" (slow, self-inflicted latency)
// and unbounded Promise.all (tripped a rate limit on the free Carbonara API
// with 6 concurrent requests in a real run — see CARBONARA_MAX_CONCURRENCY
// below). No new dependency: a fixed-size pool of workers that each pull the
// next index off a shared cursor until the queue is empty.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function createImageExtractorNode() {
  return async (state: GraphState, runtime?: Runtime): Promise<Partial<GraphState>> => {
    console.log("\n[Image Extractor] Preparing final package...");
    console.log("[Image Extractor] Snippets in state:", JSON.stringify(state.codeSnippets, null, 2));
    
    let folderName = state.suggestedFolderSlug ? slugify(state.suggestedFolderSlug) : slugify(state.initialCommand || 'generated-post');
    if (folderName.length > 20) {
      folderName = folderName.substring(0, 20).replace(/-+$/, '');
    }
    const outputDir = path.join(process.cwd(), 'output', folderName);
    await fs.mkdir(outputDir, { recursive: true });

    if (state.niche === 'out_of_scope') {
      console.warn("[Image Extractor] Command classified as OUT OF SCOPE.");
      const textPath = path.join(outputDir, 'error_report.txt');
      const errorMsg = `The provided command is out of the technical scope supported by this application.
Received command: "${state.initialCommand}"
Classified niche: "out_of_scope"
Valid niche names: "ios", "node_react", "ai_engineering".`;
      await fs.writeFile(textPath, errorMsg, 'utf-8');
      console.log(`[+] Error report saved to: ${textPath}`);
      console.log("\n✅ Process finished! Check the /output directory.\n");
      return {};
    }

    // Critical failure = the review loop was cut off at MAX_REVIEW_ATTEMPTS,
    // no approved post was produced, AND the last draft is empty/too short to
    // be worth a human's time. ('CRITICAL_FAILURE' is also checked for
    // backward compatibility, in case a node still sets that sentinel.)
    const draftTooShort = !state.technicalDraft || state.technicalDraft.trim().length < MIN_SALVAGEABLE_DRAFT_LENGTH;
    const reviewLimitReached = state.reviewCount >= MAX_REVIEW_ATTEMPTS;
    const isCriticalFailure = state.reviewFeedback === 'CRITICAL_FAILURE'
      || (!state.finalPostText && reviewLimitReached && draftTooShort);

    if (isCriticalFailure) {
      // The reviewer signaled a critical, unrecoverable failure (e.g. topic hallucination),
      // or the review loop was exhausted without ever producing a usable draft.
      // Do NOT save linkedin_post.txt — write an error report instead.
      console.error(`[Image Extractor] ❌ CRITICAL FAILURE: Content could not be validated after ${MAX_REVIEW_ATTEMPTS} reviews. Saving error report instead of draft.`);
      const errorPath = path.join(outputDir, 'error_report.txt');
      const errorMsg = `❌ CRITICAL FAILURE: The AI could not produce factually valid content after ${MAX_REVIEW_ATTEMPTS} review cycles.\n\n` +
        `This usually means:\n` +
        `- The topic involves a recent release/announcement outside the model's training cutoff.\n` +
        `- The model hallucinated about the existence or non-existence of features.\n\n` +
        `Original command: "${state.initialCommand}"\n\n` +
        `Action required: Verify the topic against the official source and retry, or provide more context (e.g., paste the article content directly into the command).`;
      await fs.writeFile(errorPath, errorMsg, 'utf-8');
      console.log(`[+] Error report saved: ${errorPath}`);
      console.log('\n✅ Process finished with errors. Check error_report.txt.\n');
      return {};
    } else if (state.finalPostText) {
      const hashtagsStr = state.hashtags ? `\n\n${state.hashtags.join(' ')}` : '';
      const textPath = path.join(outputDir, 'linkedin_post.txt');
      await fs.writeFile(textPath, `${state.finalPostText}${hashtagsStr}`, 'utf-8');
      console.log(`[+] Post text saved: ${textPath}`);
    } else if (state.technicalDraft) {
      // Review limit reached but content is present — save with a warning for manual review.
      const textPath = path.join(outputDir, 'linkedin_post.txt');
      const warningStr = `⚠️ WARNING: This post did not pass all Reviewer audits (limit of ${MAX_REVIEW_ATTEMPTS} reviews reached).\n` +
        `Verify and correct the technical information before publishing.\n\n` +
        `Last Draft:\n${state.technicalDraft}`;
      await fs.writeFile(textPath, warningStr, 'utf-8');
      console.log(`[+] Draft saved (review limit reached): ${textPath}`);
    }

    // Populated below alongside the on-disk PNGs. Kept in state so callers
    // that can't rely on the container's filesystem persisting (e.g. the
    // HTTP wrapper in src/server.ts) can still get the rendered images back.
    const codeImages: { index: number; filename: string; base64: string }[] = [];

    // Carbonara is the only external fetch in the project that had no
    // timeout (webContentService's fetchUrlContent uses 15s) — if the API
    // ever hangs, this used to be able to pin a job "running" forever.
    const CARBONARA_TIMEOUT_MS = 15_000;

    // A real run with 6 snippets fired all 6 Carbonara requests at once via
    // Promise.all and every single one timed out at 15s — earlier runs with
    // 1-3 snippets had worked fine. Carbonara is a free public API with no
    // auth; it's a reasonable guess that firing 6 concurrent requests at it
    // tripped a per-IP/global concurrency limit that a handful of parallel
    // requests doesn't. Capping concurrency keeps the "render snippets in
    // parallel, not one-by-one" win from before while staying under
    // whatever ceiling Carbonara actually has.
    const CARBONARA_MAX_CONCURRENCY = 3;

    // One snippet at a time was purely self-inflicted latency: each render
    // is an independent HTTP call to Carbonara with no dependency on the
    // others, so a post with 3 snippets paid 3x the round-trip for no
    // reason. Render them concurrently, bounded by CARBONARA_MAX_CONCURRENCY
    // above.
    async function renderSnippet(
      index: number,
      rawSnippet: string,
    ): Promise<{ index: number; filename: string; base64: string } | null> {
      // Remove prefixes like [CODE_SNIPPET_1] or [CODE_SNIPPET_1]: that the LLM may incorrectly prepend
      let codeContent = rawSnippet.replace(/^\[CODE_SNIPPET_\d+\]:?\s*/i, '');
      // Unescape literal \n sequences that appear when the model serializes code as a JSON string
      codeContent = codeContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      const ext = getExtension(state.niche, codeContent);

      // Save the original source code as text
      const codePath = path.join(outputDir, `snippet_${index + 1}.${ext}`);
      await fs.writeFile(codePath, codeContent, 'utf-8');
      console.log(`[+] Source code saved: ${codePath}`);

      if (!codeContent.trim()) {
        console.warn(`[-] Snippet ${index + 1} code content is empty (raw placeholder was passed). Skipping Carbonara image generation.`);
        return null;
      }

      const payload = {
        code: codeContent,
        backgroundColor: "rgba(171, 184, 195, 1)",
        theme: "dracula",
        windowTheme: "mac",
        dropShadow: true,
        paddingVertical: "56px",
        paddingHorizontal: "56px"
      };

      console.log(`[Carbonara API] Sending request for snippet ${index + 1} (${codeContent.length} chars). Preview: "${codeContent.substring(0, 60).replace(/\n/g, ' ')}..."`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CARBONARA_TIMEOUT_MS);

      try {
        const response = await fetch('https://carbonara.solopov.dev/api/cook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const pngBuffer = Buffer.from(buffer);
          const filename = `snippet_${index + 1}.png`;
          const imgPath = path.join(outputDir, filename);
          await fs.writeFile(imgPath, pngBuffer);
          console.log(`[+] Code image saved: ${imgPath}`);
          return { index: index + 1, filename, base64: pngBuffer.toString('base64') };
        }

        const responseBody = await response.text().catch(() => 'Unable to read response body');
        console.warn(`[-] HTTP error from Carbonara API for snippet ${index + 1}: ${response.status} ${response.statusText}`);
        console.warn(`[-] Carbonara API Error Response Body:\n${responseBody}`);
        console.warn(`[-] Sent Payload:`, JSON.stringify(payload, null, 2));
        return null;
      } catch (e) {
        const isTimeout = e instanceof Error && e.name === 'AbortError';
        console.error(
          `[-] ${isTimeout ? `Carbonara request for snippet ${index + 1} timed out after ${CARBONARA_TIMEOUT_MS / 1000}s` : `Network/Fetch error generating Carbonara image for snippet ${index + 1}`}:`,
          isTimeout ? undefined : e,
        );
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (state.codeSnippets && state.codeSnippets.length > 0) {
      const rendered = await mapWithConcurrency(
        state.codeSnippets,
        CARBONARA_MAX_CONCURRENCY,
        (snippet, i) => renderSnippet(i, snippet),
      );
      for (const img of rendered) {
        if (img) codeImages.push(img);
      }
    }
    console.log("\n✅ Process finished! Check the /output directory.\n");
    return { codeImages: codeImages.length > 0 ? codeImages : undefined };
  };
}
