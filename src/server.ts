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
import { randomUUID, timingSafeEqual } from 'crypto';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { buildPostGraph } from './graph/graph.ts';
import { OpenRouterService } from './services/openrouterService.ts';
import { renderPreviewPage } from './services/previewPage.ts';

// Built once at module scope, not per-request. Both are stateless across
// invocations: OpenRouterService only holds a configured ChatOpenAI client
// (no per-call mutable fields), and a compiled LangGraph StateGraph threads
// all request-specific data through the object passed to .invoke() rather
// than storing it on the graph instance — this is the same graph object
// LangGraph Cloud itself would reuse across many concurrent runs. Building
// both fresh on every /generate call was pure repeated setup cost (and,
// for buildPostGraph, is a real teardown/build cycle of nodes and edges)
// for zero benefit.
const llmClient = new OpenRouterService();
const graph = buildPostGraph(llmClient);

// Safety net: every individual network call in the graph has its own timeout
// (OpenRouter retries with backoff, webContentService's 15s fetch, Carbonara's
// own timeout below) — but nothing previously bounded the run as a WHOLE. If
// any single call ever hung past its own timeout logic (or a future node
// forgets to add one), the job would sit in "running" forever with no way
// for a polling client to know it's dead. This is a soft timeout: it makes
// the job report an error after GRAPH_TIMEOUT_MS, but doesn't cancel
// in-flight requests inside the graph (no AbortSignal threaded through
// LangGraph nodes) — it just stops us from waiting on them forever.
const GRAPH_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — well above the typical 1-3 min run (review retries + image rendering)

function invokeGraphWithTimeout(input: { initialCommand: string; reviewCount: number }) {
  return Promise.race([
    graph.invoke(input),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Graph run exceeded ${GRAPH_TIMEOUT_MS / 1000}s timeout.`)), GRAPH_TIMEOUT_MS).unref(),
    ),
  ]);
}

const app = express();

// Sets a solid baseline of security headers (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, disables X-Powered-By, etc.).
// This is a JSON/image API, not an HTML app, so the default CSP is harmless
// noise rather than something that needs tuning.
app.use(helmet());

// This API is meant to be called server-to-server (curl, another backend) —
// not from a browser page on a third-party origin. Explicit allowlist via
// env var, defaulting to "no cross-origin access" rather than silently
// leaving CORS unset (which is safe today, but invites someone to bolt on
// `cors()` with a wildcard later without thinking about it).
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false }));

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

// Plain `!==` short-circuits on the first differing byte, so an attacker
// measuring response times could in theory learn the key one byte at a time.
// timingSafeEqual always compares the full buffer length. It throws if the
// two buffers differ in length, so we still do a (safe, constant-shape)
// comparison in that case rather than returning early — no early return
// based on `.length` means no length-derived timing signal either.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // burn the same amount of time as a real comparison
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next(); // no key configured — warned above, allow through (e.g. local dev)
  const provided = req.header('x-api-key');
  if (!provided || !safeCompare(provided, API_KEY)) {
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

// A `topic` is meant to be a short prompt (optionally with a URL or two), not
// a document. Without a cap, express.json's 1mb limit is the only ceiling —
// a ~1MB topic gets stuffed into every specialist prompt (and re-sent on
// every review iteration), which is slow and needlessly expensive in tokens.
const MAX_TOPIC_LENGTH = 2_000;

app.post('/generate', generateLimiter, requireApiKey, (req: Request, res: Response) => {
  const { topic } = req.body ?? {};

  if (typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ error: 'Request body must include a non-empty "topic" string.' });
    return;
  }

  if (topic.length > MAX_TOPIC_LENGTH) {
    res.status(400).json({ error: `"topic" must be at most ${MAX_TOPIC_LENGTH} characters (got ${topic.length}).` });
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
      const result = await invokeGraphWithTimeout({ initialCommand: topic, reviewCount: 0 });

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

  res.status(202).json({ jobId, statusUrl: `/result/${jobId}`, previewUrl: `/result/${jobId}/preview` });
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

// Visual preview of a finished (or in-progress) post, rendered with PixiJS —
// see src/services/previewPage.ts for the full design rationale. Not behind
// requireApiKey: the HTML itself is static and holds no job data (a browser
// navigating here can't attach an x-api-key header anyway); the page's own
// JS prompts for the key and uses it for authenticated fetch() calls to
// /result/:jobId and the image routes below, which stay fully protected.
app.get('/result/:jobId/preview', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);

  if (!jobs.has(jobId)) {
    res.status(404).send('Unknown or expired jobId.');
    return;
  }

  // helmet's default CSP only allows same-origin scripts — this page needs
  // PixiJS from a CDN plus its own inline <script>, so it gets a scoped
  // override instead of loosening CSP for every route.
  res.setHeader(
    'Content-Security-Policy',
    // 'unsafe-eval' is required by PixiJS v8 itself (uses `new Function()`
    // internally for mask/filter codegen) — confirmed via a real browser
    // console error on first deploy ("Current environment does not allow
    // unsafe-eval"), not a guess. connect-src includes cdnjs so the
    // browser's devtools can fetch pixi.min.js's source map without a CSP
    // console warning (cosmetic only — app worked fine without it too).
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://cdnjs.cloudflare.com;",
  );
  res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(renderPreviewPage(jobId));
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

// Catches: malformed JSON bodies (express.json() calls next(err)), and any
// synchronous throw in a route handler above. Without this, Express's
// default error handler answers with a generic Express-branded HTML page
// (and a stack trace outside production) instead of a clean JSON error.
// Must be registered LAST, and must take exactly 4 params for Express to
// recognize it as an error handler.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const message = err instanceof Error ? err.message : String(err);
  console.error('[Server] Unhandled error in request pipeline:', message);
  res.status(400).json({ error: 'Bad request.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LangGraph Critic-RAG server listening on 0.0.0.0:${PORT}`);
});

// The /generate handler's own async work is already wrapped in try/catch
// (see above), so this is a safety net for anything outside that path —
// without it, an unhandled rejection or uncaught exception crashes the
// process with no log line explaining why, and Railway just sees the
// service die and restart.
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  // Node's own guidance: don't keep running after this — the process may be
  // in a corrupted state. Exit and let Railway restart it cleanly.
  process.exit(1);
});

// Railway sends SIGTERM before restarting/redeploying a service. Without
// handling it, in-flight requests (a /generate call mid-poll, an image
// download) get cut off mid-response instead of finishing gracefully.
function shutdown(signal: string): void {
  console.log(`[Server] ${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
  // Background /generate jobs can run for minutes; don't hang forever
  // waiting for connections to drain if something never finishes.
  setTimeout(() => {
    console.warn('[Server] Graceful shutdown timed out — forcing exit.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
