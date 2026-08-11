/**
 * Lightweight HTTP wrapper around the LangGraph Critic-RAG pipeline.
 *
 * This intentionally does NOT use `@langchain/langgraph-cli`'s Agent Server
 * (`langgraph dev` / `langgraph build`) — that path is meant for LangGraph's
 * production Agent Server offering and requires Redis, Postgres, and a
 * LANGGRAPH_CLOUD_LICENSE_KEY (paid LangSmith license). This project doesn't
 * need threads/runs/Studio — just "trigger a generation with a topic, get
 * the result back" — so a plain Express endpoint in front of the existing
 * `buildPostGraph()` graph does the job with zero extra infrastructure.
 *
 * Local dev:  npm run server:dev   (loads .env)
 * Deployed:   npm run server       (env vars come from the platform, e.g. Railway)
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { buildPostGraph } from './graph/graph.ts';
import { OpenRouterService } from './services/openrouterService.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.SERVER_API_KEY;

if (!API_KEY) {
  console.warn('⚠️  SERVER_API_KEY is not set — /generate is UNPROTECTED. Set SERVER_API_KEY before deploying publicly.');
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next(); // no key configured — warned above, allow through (e.g. local dev)
  const provided = req.header('x-api-key');
  if (provided !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized. Missing or invalid x-api-key header.' });
    return;
  }
  next();
}

// Railway (and most PaaS) health checks hit this to know the service is up.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post('/generate', requireApiKey, async (req: Request, res: Response) => {
  const { topic } = req.body ?? {};

  if (typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ error: 'Request body must include a non-empty "topic" string.' });
    return;
  }

  console.log(`[Server] /generate — topic: "${topic}"`);

  try {
    const llmClient = new OpenRouterService();
    const graph = buildPostGraph(llmClient);

    // Runs synchronously: the pipeline is a handful of LLM calls + optional
    // RAG/web fetch/image rendering, typically well under a couple of
    // minutes. Kept simple on purpose — no job queue/DB needed for a
    // "trigger and get the result back" use case.
    const result = await graph.invoke({
      initialCommand: topic,
      reviewCount: 0,
    });

    const approved = Boolean(result.finalPostText);

    res.status(200).json({
      niche: result.niche ?? null,
      folderSlug: result.suggestedFolderSlug ?? null,
      approved,
      finalPostText: result.finalPostText || null,
      hashtags: result.hashtags ?? [],
      codeSnippets: result.codeSnippets ?? [],
      // Rendered Carbonara PNGs, base64-encoded as data URIs. The container's
      // filesystem is ephemeral (no Volume attached), so this is the only
      // way to get the images back — decode client-side or drop straight
      // into an <img src="..."> / <!doctype html> preview.
      codeImages: (result.codeImages ?? []).map((img) => ({
        filename: img.filename,
        dataUri: `data:image/png;base64,${img.base64}`,
      })),
      reviewCount: result.reviewCount,
      reviewFeedback: result.reviewFeedback || null,
      // Only included when the review loop was exhausted without approval —
      // mirrors the "⚠️ WARNING" file that imageExtractorNode writes locally.
      unapprovedDraft: !approved ? (result.technicalDraft || null) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Server] /generate failed:', message);
    res.status(500).json({ error: 'Generation failed', details: message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LangGraph Critic-RAG server listening on 0.0.0.0:${PORT}`);
});
