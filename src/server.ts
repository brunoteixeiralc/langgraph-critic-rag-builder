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
 * IMAGES SERVED SEPARATELY: rendered Carbonara PNGs are NOT inlined as
 * base64 inside the /result/:jobId JSON. A single snippet image can be
 * 100KB+, which base64-inflates by ~33% and can push the JSON response past
 * 1MB. Some networks (corporate proxies especially) mangle or truncate large
 * response bodies — we hit exactly that. So /result/:jobId only returns a
 * `url` per image, and GET /result/:jobId/images/:filename serves the raw
 * PNG bytes directly (small, normal binary response, no proxy weirdness).
 *
 * Local dev:  npm run server:dev   (loads .env)
 * Deployed:   npm run server       (env vars come from the platform, e.g. Railway)
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { buildPostGraph } from './graph/graph.ts';
import { OpenRouterService } from './services/openrouterService.ts';

const app = express();

// Railway (and most PaaS providers) sit in front of this app as a reverse
// proxy. Without this, req.ip resolves to the proxy's address for every
// request — rate limiting below would either lump all callers together or
// express-rate-limit would refuse to start (it validates X-Forwarded-For
// usage once trust proxy is misconfigured). Trust exactly one hop.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.SERVER_API_KEY;

if (!API_KEY) {
  console.warn('⚠️  SERVER_API_KEY is not set — endpoints are UNPROTECTED. Set SERVER_API_KEY before deploying publicly.');
} else if (API_KEY.length < 32) {
  console.warn(`⚠️  SERVER_API_KEY is only ${API_KEY.length} chars — recommend 32+ random bytes, e.g.: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
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

// --- Rate limiting -----------------------------------------------------
// POST /generate is the "denial of wallet" surface: each call triggers
// several paid OpenRouter calls plus Gemini embeddings, so it gets a tight
// per-IP cap. Applied BEFORE requireApiKey so it also throttles someone
// hammering the endpoint without a valid key, not just legitimate callers.
const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10, // 10 generations / 15min / IP — generous for manual/personal use, caps a runaway script or a leaked key
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many /generate requests. Please wait before trying again.' },
});

// Looser global cap — GET /result/:jobId is meant to be polled every few
// seconds while a job runs, so this just guards against abuse, not normal use.
const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
app.use(pollLimiter);

// --- In-memory job store ---------------------------------------------------

type JobStatus = 'pending' | 'running' | 'done' | 'error';

// Images are kept as raw Buffers, not base64 strings. Base64 inflates size by
// ~33% for no benefit here — the only consumer is the /images/:filename route,
// which writes bytes straight to the response either way.
type StoredImage = { filename: string; buffer: Buffer };

type Job = {
  status: JobStatus;
  topic: string;
  createdAt: number;
  updatedAt: number;
  result?: Record<string, unknown>;
  images?: StoredImage[];
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

// The TTL sweep above only runs every 15min — a burst of /generate calls
// within that window could otherwise grow the map unboundedly (each job
// holds a full result payload plus PNG buffers). Cap the count too, evicting
// the oldest job to make room, same idea as an LRU with insertion order.
const MAX_JOBS = 200;

function evictOldestJobIfAtCapacity(): void {
  if (jobs.size < MAX_JOBS) return;

  let oldestId: string | undefined;
  let oldestCreatedAt = Infinity;
  for (const [id, job] of jobs) {
    if (job.createdAt < oldestCreatedAt) {
      oldestCreatedAt = job.createdAt;
      oldestId = id;
    }
  }

  if (oldestId) {
    jobs.delete(oldestId);
    console.warn(`[Server] Job store at capacity (${MAX_JOBS}) — evicted oldest job ${oldestId}.`);
  }
}

function serializeGraphResult(
  jobId: string,
  result: Awaited<ReturnType<ReturnType<typeof buildPostGraph>['invoke']>>,
): { json: Record<string, unknown>; images: StoredImage[] } {
  const approved = Boolean(result.finalPostText);
  const images: StoredImage[] = (result.codeImages ?? []).map((img) => ({
    filename: img.filename,
    buffer: Buffer.from(img.base64, 'base64'), // decode once here, not on every image request
  }));

  const json = {
    niche: result.niche ?? null,
    folderSlug: result.suggestedFolderSlug ?? null,
    approved,
    finalPostText: result.finalPostText || null,
    hashtags: result.hashtags ?? [],
    codeSnippets: result.codeSnippets ?? [],
    // Fetch each rendered PNG separately — see file header for why.
    codeImages: images.map((img) => ({
      filename: img.filename,
      url: `/result/${jobId}/images/${encodeURIComponent(img.filename)}`,
    })),
    reviewCount: result.reviewCount,
    reviewFeedback: result.reviewFeedback || null,
    // Only included when the review loop was exhausted without approval —
    // mirrors the "⚠️ WARNING" file that imageExtractorNode writes locally.
    unapprovedDraft: !approved ? (result.technicalDraft || null) : undefined,
  };

  return { json, images };
}

// --- Routes ------------------------------------------------------------

// Railway (and most PaaS) health checks hit this to know the service is up.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post('/generate', generateLimiter, requireApiKey, (req: Request, res: Response) => {
  const { topic } = req.body ?? {};

  if (typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ error: 'Request body must include a non-empty "topic" string.' });
    return;
  }

  evictOldestJobIfAtCapacity();

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

      const { json, images } = serializeGraphResult(jobId, result);
      job.status = 'done';
      job.result = json;
      job.images = images;
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

app.get('/result/:jobId/images/:filename', requireApiKey, (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const filename = String(req.params.filename);
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'Unknown or expired jobId.' });
    return;
  }

  const image = job.images?.find((img) => img.filename === filename);
  if (!image) {
    res.status(404).json({ error: 'No such image for this job.' });
    return;
  }

  res.status(200).set('Content-Type', 'image/png').send(image.buffer);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LangGraph Critic-RAG server listening on 0.0.0.0:${PORT}`);
});
