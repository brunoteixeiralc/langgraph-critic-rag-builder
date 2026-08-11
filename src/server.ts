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
 * ASYNC BY DESIGN: the pipeline can take 1-3+ minutes (review loop retries +
 * Carbonara image rendering), which is long enough that some client, proxy,
 * or corporate firewall between the caller and Railway is likely to close an
 * idle-looking connection before a synchronous response comes back — Railway
 * itself allows up to 15 minutes, but we don't control every network hop in
 * between. So POST /generate returns immediately with a jobId, and the
 * caller polls GET /result/:jobId until it's done. No DB/queue needed: jobs
 * live in memory, which is fine as long as this runs as a single replica
 * (true today — if you ever scale to multiple instances, a job created on
 * one instance won't be visible from another, and you'd need to move this
 * to Redis/Postgres or sticky sessions).
 *
 * Local dev:  npm run server:dev   (loads .env)
 * Deployed:   npm run server       (env vars come from the platform, e.g. Railway)
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { buildPostGraph } from './graph/graph.ts';
import { OpenRouterService } from './services/openrouterService.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.SERVER_API_KEY;

if (!API_KEY) {
  console.warn('⚠️  SERVER_API_KEY is not set — endpoints are UNPROTECTED. Set SERVER_API_KEY before deploying publicly.');
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

// --- In-memory job store ---------------------------------------------------

type JobStatus = 'pending' | 'running' | 'done' | 'error';

type Job = {
  status: JobStatus;
  topic: string;
  createdAt: number;
  updatedAt: number;
  result?: Record<string, unknown>;
  error?: string;
};

const jobs = new Map<string, Job>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — plenty of time to poll, keeps memory bounded
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 15 * 60 * 1000).unref(); // sweep every 15min; unref so it doesn't keep the process alive on its own

function serializeGraphResult(result: Awaited<ReturnType<ReturnType<typeof buildPostGraph>['invoke']>>) {
  const approved = Boolean(result.finalPostText);
  return {
    niche: result.niche ?? null,
    folderSlug: result.suggestedFolderSlug ?? null,
    approved,
    finalPostText: result.finalPostText || null,
    hashtags: result.hashtags ?? [],
    codeSnippets: result.codeSnippets ?? [],
    // Rendered Carbonara PNGs, base64-encoded as data URIs. The container's
    // filesystem is ephemeral (no Volume attached), so this is the only way
    // to get the images back — decode client-side or drop straight into an
    // <img src="..."> / HTML preview.
    codeImages: (result.codeImages ?? []).map((img) => ({
      filename: img.filename,
      dataUri: `data:image/png;base64,${img.base64}`,
    })),
    reviewCount: result.reviewCount,
    reviewFeedback: result.reviewFeedback || null,
    // Only included when the review loop was exhausted without approval —
    // mirrors the "⚠️ WARNING" file that imageExtractorNode writes locally.
    unapprovedDraft: !approved ? (result.technicalDraft || null) : undefined,
  };
}

// --- Routes ------------------------------------------------------------

// Railway (and most PaaS) health checks hit this to know the service is up.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post('/generate', requireApiKey, (req: Request, res: Response) => {
  const { topic } = req.body ?? {};

  if (typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ error: 'Request body must include a non-empty "topic" string.' });
    return;
  }

  const jobId = randomUUID();
  const now = Date.now();
  jobs.set(jobId, { status: 'pending', topic, createdAt: now, updatedAt: now });

  console.log(`[Server] /generate — job ${jobId} queued. Topic: "${topic}"`);

  // Fire and forget: the HTTP response below returns immediately. The graph
  // keeps running in the background and updates the job record when done.
  (async () => {
    const job = jobs.get(jobId);
    if (!job) return; // evicted already (shouldn't happen this fast, but be safe)
    job.status = 'running';
    job.updatedAt = Date.now();

    try {
      const llmClient = new OpenRouterService();
      const graph = buildPostGraph(llmClient);
      const result = await graph.invoke({ initialCommand: topic, reviewCount: 0 });

      job.status = 'done';
      job.result = serializeGraphResult(result);
      job.updatedAt = Date.now();
      console.log(`[Server] job ${jobId} done.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.status = 'error';
      job.error = message;
      job.updatedAt = Date.now();
      console.error(`[Server] job ${jobId} failed:`, message);
    }
  })();

  res.status(202).json({ jobId, statusUrl: `/result/${jobId}` });
});

app.get('/result/:jobId', requireApiKey, (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'Unknown or expired jobId.' });
    return;
  }

  if (job.status === 'pending' || job.status === 'running') {
    res.status(200).json({ status: job.status, topic: job.topic });
    return;
  }

  if (job.status === 'error') {
    res.status(500).json({ status: 'error', topic: job.topic, error: job.error });
    return;
  }

  res.status(200).json({ status: 'done', topic: job.topic, ...job.result });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LangGraph Critic-RAG server listening on 0.0.0.0:${PORT}`);
});
