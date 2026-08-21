import fs from 'fs/promises';
import path from 'path';
import type { Runtime } from '@langchain/langgraph';
import type { GraphState } from '../graph.ts';
import { MAX_REVIEW_ATTEMPTS } from './edgeConditions.ts';
import { codeToImage } from 'shiki-image';
import type { BundledLanguage } from 'shiki';
import sharp from 'sharp';

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

// Maps the on-disk extension (from getExtension above) to a Shiki grammar
// name for the fallback renderer below. Kept as its own tiny function
// rather than folding into getExtension because the two vocabularies
// diverge (file extensions vs. Shiki's language ids).
function shikiLangForExtension(ext: string): BundledLanguage {
  if (ext === 'swift') return 'swift';
  if (ext === 'py') return 'python';
  return 'typescript';
}

// 3x5 dot-matrix bitmap font for digits 0-9, used by the number badge below
// instead of an SVG <text> element. Confirmed root cause of a real bug: the
// badge circle rendered fine but the digit inside it was completely
// invisible — Railway's container has no fonts installed at all, so
// librsvg/resvg silently drops any <text> element it can't match to a real
// font instead of erroring (no exception, no log, just a blank result).
// Rects have no font dependency and render identically in any environment.
const DIGIT_GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

// Builds the <rect> markup for a (possibly multi-digit) number using
// DIGIT_GLYPHS above, laid out left to right. Returns the fragment plus its
// total pixel width/height so the caller can size the badge pill around it.
function buildDigitsSvgFragment(numberStr: string, pixelSize: number, gapBetweenDigits: number): { fragment: string; width: number; height: number } {
  const GLYPH_COLS = 3;
  const GLYPH_ROWS = 5;
  const glyphWidth = GLYPH_COLS * pixelSize;
  const glyphHeight = GLYPH_ROWS * pixelSize;
  let fragment = '';
  let xOffset = 0;
  for (const ch of numberStr) {
    const pattern = DIGIT_GLYPHS[ch] ?? DIGIT_GLYPHS['0'];
    pattern.forEach((row, rowIndex) => {
      for (let col = 0; col < GLYPH_COLS; col++) {
        if (row[col] === '1') {
          const x = xOffset + col * pixelSize;
          const y = rowIndex * pixelSize;
          fragment += `<rect x="${x}" y="${y}" width="${pixelSize}" height="${pixelSize}" fill="#ffffff" />`;
        }
      }
    });
    xOffset += glyphWidth + gapBetweenDigits;
  }
  const totalWidth = Math.max(glyphWidth, xOffset - gapBetweenDigits);
  return { fragment, width: totalWidth, height: glyphHeight };
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
    // `source` tracks which renderer actually produced each image (Carbonara
    // vs the Shiki fallback below) — surfaced as a small badge on the
    // preview page so it's visible at a glance instead of needing to dig
    // through Railway logs to answer "which one rendered this?".
    const codeImages: { index: number; filename: string; base64: string; source: 'carbonara' | 'shiki' }[] = [];

    // Carbonara doesn't just serve a pre-rendered image — per its own repo
    // (petersolopov/carbonara), it launches a headless Chromium via
    // Puppeteer, navigates to carbon.now.sh, and screenshots the result.
    // That's inherently slow, and it's a free personal project with no SLA,
    // not a production image API. 15s was too tight for that: two real runs
    // in a row saw 100% (5/5, 6/6) of snippets time out. 30s gives a
    // Puppeteer cold-start + navigation + render + screenshot realistic room.
    const CARBONARA_TIMEOUT_MS = 30_000;

    // A real run firing all 6 requests at once via Promise.all saw every
    // single one time out; capping at 3 didn't help either (still 5/5
    // timeouts on a later run) — the bottleneck isn't really concurrency at
    // this service, it's raw per-request latency (see above). Still capping
    // at 2 rather than removing the limit entirely: no reason to hand a
    // free, unauthenticated, browser-automation-backed service more
    // simultaneous Chromium instances than necessary.
    const CARBONARA_MAX_CONCURRENCY = 2;

    // Given how consistently every snippet has been timing out, treating a
    // single attempt as final wastes the code (and the LLM work that
    // produced it) on what's often just a slow/flaky upstream call. One
    // retry, no backoff needed — the timeout itself already burns 30s.
    const CARBONARA_MAX_ATTEMPTS = 2;

    async function fetchCarbonaraImage(index: number, codeContent: string): Promise<Buffer | null> {
      const payload = {
        code: codeContent,
        backgroundColor: "rgba(171, 184, 195, 1)",
        theme: "dracula",
        windowTheme: "mac",
        dropShadow: true,
        paddingVertical: "56px",
        paddingHorizontal: "56px"
      };

      for (let attempt = 1; attempt <= CARBONARA_MAX_ATTEMPTS; attempt++) {
        console.log(`[Carbonara API] Sending request for snippet ${index + 1} (attempt ${attempt}/${CARBONARA_MAX_ATTEMPTS}, ${codeContent.length} chars). Preview: "${codeContent.substring(0, 60).replace(/\n/g, ' ')}..."`);

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
            return Buffer.from(buffer);
          }

          const responseBody = await response.text().catch(() => 'Unable to read response body');
          console.warn(`[-] HTTP error from Carbonara API for snippet ${index + 1} (attempt ${attempt}/${CARBONARA_MAX_ATTEMPTS}): ${response.status} ${response.statusText}`);
          console.warn(`[-] Carbonara API Error Response Body:\n${responseBody}`);
        } catch (e) {
          const isTimeout = e instanceof Error && e.name === 'AbortError';
          console.error(
            `[-] ${isTimeout ? `Carbonara request for snippet ${index + 1} timed out after ${CARBONARA_TIMEOUT_MS / 1000}s (attempt ${attempt}/${CARBONARA_MAX_ATTEMPTS})` : `Network/Fetch error generating Carbonara image for snippet ${index + 1} (attempt ${attempt}/${CARBONARA_MAX_ATTEMPTS})`}:`,
            isTimeout ? undefined : e,
          );
        } finally {
          clearTimeout(timeout);
        }
      }

      return null;
    }

    // Carbonara has no documented rate limit or SLA — it's a free,
    // unauthenticated wrapper around a headless-Chromium screenshot of
    // carbon.now.sh, run on whatever the maintainer's personal host can
    // spare. In practice that's shown up as exactly the failure mode above:
    // real runs where every single snippet times out, retry included.
    // shiki-image (shiki for syntax highlighting + the Rust-based Takumi
    // renderer, both running in-process via native bindings — no network
    // call, no third party) renders in milliseconds and can't rate-limit or
    // go down independently of this process. It won't match Carbonara's
    // carbon.now.sh chrome (window controls, drop shadow) pixel-for-pixel,
    // but a plain, correctly syntax-highlighted code image beats no image
    // at all, which is what every prior run had for the snippets that timed
    // out.
    async function renderShikiFallback(codeContent: string, ext: string): Promise<Buffer | null> {
      try {
        const buffer = await codeToImage(codeContent, {
          lang: shikiLangForExtension(ext),
          theme: 'dracula', // same theme Carbonara is configured with above, for visual consistency between the two paths
          format: 'png',
          style: { padding: 32, borderRadius: 12 },
        });
        return Buffer.from(buffer);
      } catch (e) {
        console.error('[Shiki Fallback] Failed to render image locally:', e instanceof Error ? e.message : e);
        return null;
      }
    }

    // Bakes a small numbered badge into the top-left corner of the rendered
    // code image, matching the "(exemplo N 👇)" cue now placed in the post
    // text (see previewPage.ts's getPlainPostText). This has to be burned
    // into the actual PNG pixels, not just drawn on the preview <canvas> —
    // once these get uploaded to LinkedIn's own multi-image gallery,
    // LinkedIn has no concept of "this is example 2", the filename is
    // discarded, and the only thing that survives the upload for a reader
    // to match an image back to its mention in the text is what's visibly
    // printed on the image itself.
    async function addNumberBadge(pngBuffer: Buffer, displayIndex: number): Promise<Buffer> {
      try {
        const image = sharp(pngBuffer);
        const metadata = await image.metadata();
        const width = metadata.width ?? 800;
        const badgeHeight = Math.max(28, Math.min(48, Math.round(width * 0.045)));
        // 5 rows tall per digit (see DIGIT_GLYPHS) + padding above/below —
        // solve for a pixelSize that makes the digit grid fit badgeHeight.
        const pixelSize = Math.max(2, Math.round(badgeHeight / 9));
        const gapBetweenDigits = pixelSize;
        const paddingX = pixelSize * 2;
        const paddingY = pixelSize * 2;
        const numberStr = String(displayIndex);
        const digits = buildDigitsSvgFragment(numberStr, pixelSize, gapBetweenDigits);
        const pillWidth = digits.width + paddingX * 2;
        const pillHeight = digits.height + paddingY * 2;
        const margin = Math.round(pillHeight * 0.35);
        const svg = `<svg width="${pillWidth}" height="${pillHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${pillWidth}" height="${pillHeight}" rx="${pillHeight / 2}" ry="${pillHeight / 2}" fill="#0a66c2" fill-opacity="0.95" />
  <g transform="translate(${paddingX}, ${paddingY})">${digits.fragment}</g>
</svg>`;
        return await image
          .composite([{ input: Buffer.from(svg), top: margin, left: margin }])
          .png()
          .toBuffer();
      } catch (e) {
        console.warn(`[Image Extractor] Failed to bake number badge onto snippet ${displayIndex} — shipping the image without it:`, e instanceof Error ? e.message : e);
        return pngBuffer;
      }
    }

    // One snippet at a time was purely self-inflicted latency: each render
    // is an independent HTTP call to Carbonara with no dependency on the
    // others, so a post with 3 snippets paid 3x the round-trip for no
    // reason. Render them concurrently, bounded by CARBONARA_MAX_CONCURRENCY
    // above.
    async function renderSnippet(
      index: number,
      rawSnippet: string,
    ): Promise<{ index: number; filename: string; base64: string; source: 'carbonara' | 'shiki' } | null> {
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

      let pngBuffer = await fetchCarbonaraImage(index, codeContent);
      let source: 'carbonara' | 'shiki' = 'carbonara';
      if (!pngBuffer) {
        console.warn(`[-] Snippet ${index + 1}: all ${CARBONARA_MAX_ATTEMPTS} Carbonara attempts failed — falling back to local Shiki rendering.`);
        source = 'shiki';
        pngBuffer = await renderShikiFallback(codeContent, ext);
        if (pngBuffer) {
          console.log(`[+] Snippet ${index + 1}: rendered via Shiki fallback (${pngBuffer.length} bytes).`);
        } else {
          console.error(`[-] Snippet ${index + 1}: Shiki fallback also failed — no image for this snippet.`);
          return null;
        }
      }

      pngBuffer = await addNumberBadge(pngBuffer, index + 1);

      const filename = `snippet_${index + 1}.png`;
      const imgPath = path.join(outputDir, filename);
      await fs.writeFile(imgPath, pngBuffer);
      console.log(`[+] Code image saved: ${imgPath}`);
      return { index: index + 1, filename, base64: pngBuffer.toString('base64'), source };
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
