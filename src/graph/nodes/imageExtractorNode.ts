import fs from 'fs/promises';
import path from 'path';
import type { Runtime } from '@langchain/langgraph';
import type { GraphState } from '../graph.ts';

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

function getExtension(niche?: string, code?: string): string {
  if (niche === 'flutter_dart') return 'dart';
  if (niche === 'ai_engineering') {
    if (code && (code.includes('import ') || code.includes('def ') || code.includes('print(')) && !code.includes('console.log')) {
      return 'py';
    }
    return 'ts';
  }
  return 'ts';
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
Valid niche names: "flutter_dart", "node_react", "ai_engineering".`;
      await fs.writeFile(textPath, errorMsg, 'utf-8');
      console.log(`[+] Error report saved to: ${textPath}`);
      console.log("\n✅ Process finished! Check the /output directory.\n");
      return { reviewCount: 0 };
    }

    if (state.reviewFeedback === 'CRITICAL_FAILURE') {
      // The reviewer signaled a critical, unrecoverable failure (e.g. topic hallucination).
      // Do NOT save linkedin_post.txt — write an error report instead.
      console.error('[Image Extractor] ❌ CRITICAL FAILURE: Content could not be validated after 3 reviews. Saving error report instead of draft.');
      const errorPath = path.join(outputDir, 'error_report.txt');
      const errorMsg = `❌ CRITICAL FAILURE: The AI could not produce factually valid content after 3 review cycles.\n\n` +
        `This usually means:\n` +
        `- The topic involves a recent release/announcement outside the model's training cutoff.\n` +
        `- The model hallucinated about the existence or non-existence of features.\n\n` +
        `Original command: "${state.initialCommand}"\n\n` +
        `Action required: Verify the topic against the official source and retry, or provide more context (e.g., paste the article content directly into the command).`;
      await fs.writeFile(errorPath, errorMsg, 'utf-8');
      console.log(`[+] Error report saved: ${errorPath}`);
      console.log('\n✅ Process finished with errors. Check error_report.txt.\n');
      return { reviewCount: 0 };
    } else if (state.finalPostText) {
      const hashtagsStr = state.hashtags ? `\n\n${state.hashtags.join(' ')}` : '';
      const textPath = path.join(outputDir, 'linkedin_post.txt');
      await fs.writeFile(textPath, `${state.finalPostText}${hashtagsStr}`, 'utf-8');
      console.log(`[+] Post text saved: ${textPath}`);
    } else if (state.technicalDraft) {
      // Review limit reached but content is present — save with a warning for manual review.
      const textPath = path.join(outputDir, 'linkedin_post.txt');
      const warningStr = `⚠️ WARNING: This post did not pass all Reviewer audits (limit of 3 reviews reached).\n` +
        `Verify and correct the technical information before publishing.\n\n` +
        `Last Draft:\n${state.technicalDraft}`;
      await fs.writeFile(textPath, warningStr, 'utf-8');
      console.log(`[+] Draft saved (review limit reached): ${textPath}`);
    }

    if (state.codeSnippets && state.codeSnippets.length > 0) {
      for (let i = 0; i < state.codeSnippets.length; i++) {
        let codeContent = state.codeSnippets[i];
        // Remove prefixes like [CODE_SNIPPET_1] or [CODE_SNIPPET_1]: that the LLM may incorrectly prepend
        codeContent = codeContent.replace(/^\[CODE_SNIPPET_\d+\]:?\s*/i, '');
        // Unescape literal \n sequences that appear when the model serializes code as a JSON string
        codeContent = codeContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
        const ext = getExtension(state.niche, codeContent);
        
        // Save the original source code as text
        const codePath = path.join(outputDir, `snippet_${i + 1}.${ext}`);
        await fs.writeFile(codePath, codeContent, 'utf-8');
        console.log(`[+] Source code saved: ${codePath}`);

        if (!codeContent.trim()) {
          console.warn(`[-] Snippet ${i + 1} code content is empty (raw placeholder was passed). Skipping Carbonara image generation.`);
          continue;
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

        console.log(`[Carbonara API] Sending request for snippet ${i + 1} (${codeContent.length} chars). Preview: "${codeContent.substring(0, 60).replace(/\n/g, ' ')}..."`);

        try {
          const response = await fetch('https://carbonara.solopov.dev/api/cook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            const buffer = await response.arrayBuffer();
            const imgPath = path.join(outputDir, `snippet_${i + 1}.png`);
            await fs.writeFile(imgPath, Buffer.from(buffer));
            console.log(`[+] Code image saved: ${imgPath}`);
          } else {
            const responseBody = await response.text().catch(() => 'Unable to read response body');
            console.warn(`[-] HTTP error from Carbonara API for snippet ${i + 1}: ${response.status} ${response.statusText}`);
            console.warn(`[-] Carbonara API Error Response Body:\n${responseBody}`);
            console.warn(`[-] Sent Payload:`, JSON.stringify(payload, null, 2));
          }
        } catch (e) {
          console.error(`[-] Network/Fetch error generating Carbonara image for snippet ${i + 1}:`, e);
        }
      }
    }
    console.log("\n✅ Process finished! Check the /output directory.\n");
    return { reviewCount: 0 };
  };
}
