/**
 * Serves a single self-contained HTML page (see server.ts's
 * `GET /result/:jobId/preview`) that renders a generated post the way it
 * would actually look on LinkedIn: final text with the [IMAGE_CODE_N]
 * placeholders swapped for the real rendered code-snippet images, and
 * hashtags below — instead of reading raw JSON.
 *
 * The post itself is drawn with PixiJS onto a <canvas> (per explicit choice
 * over plain HTML/CSS). Everything else on the page — the API key field,
 * status messages, topic/niche/approval info — is plain HTML/CSS; only the
 * "post card" content goes through Pixi.
 *
 * AUTH: this page's HTML is static and contains no job data — safe to serve
 * without the x-api-key check server.ts applies to every other route (a
 * browser navigating here can't attach custom headers anyway). Once loaded,
 * the page's own JS asks for the key in a password field and uses it for
 * authenticated fetch() calls to /result/:jobId and the image endpoints —
 * same auth model as curl, just triggered from a form instead of a header.
 *
 * NOTE: this was written against PixiJS v8's documented API (async
 * `app.init()`, `app.canvas`, object-form `new PIXI.Text({ text, style })`,
 * and the explicit `new PIXI.ImageSource({ resource })` + `new PIXI.Texture({ source })`
 * two-step for building a texture from an already-decoded ImageBitmap) but
 * was not exercised in a real browser before shipping — there's no browser
 * available in the environment this was built in. Report back anything that
 * looks wrong (blank canvas, console errors) and it can be fixed from there.
 */
export function renderPreviewPage(jobId: string): string {
  // jobId is a randomUUID() the caller already confirmed exists in the job
  // store before calling this — safe to interpolate directly, no user input
  // reaches this string.
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Preview — ${jobId}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/8.14.3/pixi.min.js"></script>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 16px 64px;
    background: #f3f2ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .toolbar {
    width: 100%;
    max-width: 640px;
    background: #fff;
    border: 1px solid #e0dfdc;
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .toolbar h1 { font-size: 16px; margin: 0 0 12px; }
  .keyRow { display: flex; gap: 8px; }
  .keyRow input {
    flex: 1;
    padding: 8px 10px;
    border: 1px solid #cfcfcf;
    border-radius: 6px;
    font-size: 14px;
  }
  .keyRow button {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: #0a66c2;
    color: #fff;
    font-size: 14px;
    cursor: pointer;
  }
  .keyRow button:hover { background: #004182; }
  #status { margin-top: 10px; font-size: 13px; color: #555; min-height: 16px; }
  #headerInfo { margin-top: 10px; font-size: 13px; line-height: 1.6; }
  #headerInfo .topic { margin-bottom: 6px; }
  .badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 10px;
    margin-right: 6px;
    background: #eef3f8;
    color: #0a66c2;
  }
  .badge-ok { background: #e7f6ec; color: #1a7f37; }
  .badge-warn { background: #fdecea; color: #c0392b; }
  .feedback {
    margin-top: 10px;
    padding: 10px 12px;
    background: #fdecea;
    border: 1px solid #f3c9c4;
    border-radius: 6px;
    color: #7a2e26;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: normal;
  }
  #canvasContainer {
    width: 100%;
    max-width: 640px;
    background: #fff;
    border: 1px solid #e0dfdc;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  }
  #canvasContainer canvas { display: block; }

  /* Skeleton shown while the job is pending/running, instead of a blank
     card — purely cosmetic, no data. */
  .skeleton { padding: 24px; }
  .skeleton-line {
    height: 14px;
    border-radius: 4px;
    background: linear-gradient(90deg, #eee 25%, #f5f5f5 37%, #eee 63%);
    background-size: 400% 100%;
    animation: skeleton-pulse 1.4s ease infinite;
    margin-bottom: 12px;
  }
  .skeleton-line.w60 { width: 60%; }
  .skeleton-line.w80 { width: 80%; }
  .skeleton-line.block { height: 120px; border-radius: 8px; margin-top: 4px; }
  @keyframes skeleton-pulse {
    0% { background-position: 100% 50%; }
    100% { background-position: 0 50%; }
  }
</style>
</head>
<body>

  <div class="toolbar">
    <h1>🚀 Preview do post — job ${jobId}</h1>
    <div class="keyRow">
      <input id="apiKey" type="password" placeholder="Cole sua x-api-key aqui" autocomplete="off">
      <button id="loadBtn">Carregar</button>
    </div>
    <div id="status"></div>
    <div id="headerInfo"></div>
  </div>

  <div id="canvasContainer"></div>

<script>
(function () {
  var jobId = ${JSON.stringify(jobId)};
  var apiKeyInput = document.getElementById('apiKey');
  var loadBtn = document.getElementById('loadBtn');
  var statusEl = document.getElementById('status');
  var headerEl = document.getElementById('headerInfo');
  var canvasContainer = document.getElementById('canvasContainer');
  var pollTimer = null;

  loadBtn.addEventListener('click', function () { startPolling(); });
  apiKeyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') startPolling();
  });

  function startPolling() {
    var key = apiKeyInput.value.trim();
    if (!key) { setStatus('Cole sua x-api-key acima.', true); return; }
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    poll(key);
  }

  function poll(key) {
    setStatus('Carregando...', false);
    fetch('/result/' + jobId, { headers: { 'x-api-key': key } })
      .then(function (res) {
        if (res.status === 401) throw new Error('Chave invalida (401).');
        if (res.status === 404) throw new Error('Job nao encontrado ou expirado (404).');
        // 500 is how the server reports a *job* that failed (bad topic,
        // graph timeout, LLM error, etc) — it still returns a real JSON
        // body ({status:'error', error: '...'}), not just an HTTP failure.
        // Previously this branch threw a generic "Erro HTTP 500" before
        // ever reading that body, hiding the actual failure reason from the
        // user. Any other unexpected non-2xx status still gets the generic
        // message.
        if (!res.ok && res.status !== 500) throw new Error('Erro HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { handleResult(data, key); })
      .catch(function (err) { setStatus(err.message, true); });
  }

  var skeletonShown = false;

  function handleResult(data, key) {
    if (data.status === 'pending' || data.status === 'running') {
      setStatus('Status: ' + data.status + ' — atualizando a cada 3s...', false);
      showSkeleton();
      pollTimer = setTimeout(function () { poll(key); }, 3000);
      return;
    }
    if (data.status === 'error') {
      setStatus('Job falhou: ' + data.error, true);
      return;
    }
    setStatus('Pronto.', false);
    skeletonShown = false;
    renderHeader(data);
    renderCard(data, key);
  }

  // Pulsing placeholder blocks instead of a blank card while waiting.
  // Guarded so it doesn't get re-injected (and its CSS animation restarted)
  // on every 3s poll tick — only the first time we see pending/running.
  function showSkeleton() {
    if (skeletonShown) return;
    skeletonShown = true;
    canvasContainer.innerHTML =
      '<div class="skeleton">' +
      '<div class="skeleton-line w80"></div>' +
      '<div class="skeleton-line w60"></div>' +
      '<div class="skeleton-line block"></div>' +
      '<div class="skeleton-line w80"></div>' +
      '<div class="skeleton-line w60"></div>' +
      '</div>';
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#c0392b' : '#555';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderHeader(data) {
    var approved = !!data.approved;
    var html = '';
    html += '<div class="topic"><strong>Topic:</strong> ' + escapeHtml(data.topic) + '</div>';
    if (data.niche) html += '<span class="badge">' + escapeHtml(data.niche) + '</span>';
    html += approved
      ? '<span class="badge badge-ok">Aprovado pelo reviewer</span>'
      : '<span class="badge badge-warn">NAO aprovado — reviewCount: ' + escapeHtml(data.reviewCount) + '</span>';
    // The server has always returned reviewFeedback (the reviewer's own
    // explanation of what's wrong, from its last pass), the page just never
    // showed it — you'd see "NAO aprovado" with no way to know why without
    // digging into LangSmith. Show it whenever the post wasn't approved.
    if (!approved && data.reviewFeedback) {
      html += '<div class="feedback"><strong>Motivo da reprovacao:</strong><br>' + escapeHtml(data.reviewFeedback).replace(/\\n/g, '<br>') + '</div>';
    }
    headerEl.innerHTML = html;
  }

  function renderCard(data, key) {
    var text = data.finalPostText || data.unapprovedDraft || '(sem conteudo)';
    var imagesByIndex = {};
    (data.codeImages || []).forEach(function (img) {
      // Filenames are always "snippet_N.png" (see imageExtractorNode.ts),
      // N being the ORIGINAL 1-indexed snippet number — not the array
      // position. If any snippet failed to render (a real, observed
      // failure mode: Carbonara can time out on some snippets but not
      // others), codeImages ends up shorter than codeSnippets and the
      // surviving entries shift left in the array. Keying by array
      // position (the old "i + 1" approach) then silently maps a real
      // image to the WRONG [IMAGE_CODE_N] placeholder instead of just
      // skipping the missing one. Parsing N from the filename is correct
      // regardless of how many images failed or where.
      var match = /snippet_(\d+)\.png$/.exec(img.filename || '');
      if (!match) { console.warn('Preview: could not parse snippet index from filename', img.filename); return; }
      imagesByIndex[parseInt(match[1], 10)] = img;
    });

    var segments = splitByPlaceholders(text);

    loadAllTextures(segments, imagesByIndex, key)
      .then(function () {
        // loadAllTextures never rejects (each image job has its own catch),
        // so a failed fetch/decode used to be visible only as a
        // console.warn — the card would render with the image just quietly
        // missing and no clue why. Surface it on the page itself: cheap to
        // add, and turns "images didn't show up" reports into an actual
        // reason (404 on the image route, decode error, etc) on the next test.
        reportImageIssues(segments, imagesByIndex);
        return buildPixiCard(segments, data.hashtags || []);
      })
      .catch(function (err) { setStatus('Erro montando o preview: ' + err.message, true); });
  }

  function reportImageIssues(segments, imagesByIndex) {
    var imageSegs = segments.filter(function (s) { return s.type === 'image'; });
    if (imageSegs.length === 0) return;

    var neverGenerated = imageSegs
      .filter(function (s) { return !imagesByIndex[s.index]; })
      .map(function (s) { return s.index; });
    var failedToLoad = imageSegs
      .filter(function (s) { return imagesByIndex[s.index] && s.skip; })
      .map(function (s) { return '#' + s.index + (s.loadError ? ' (' + s.loadError + ')' : ''); });

    if (neverGenerated.length === 0 && failedToLoad.length === 0) return;

    var parts = [];
    if (neverGenerated.length > 0) parts.push('Sem imagem gerada (Carbonara falhou): [' + neverGenerated.join(', ') + ']');
    if (failedToLoad.length > 0) parts.push('Imagem gerada mas falhou ao carregar no preview: ' + failedToLoad.join(', '));

    var div = document.createElement('div');
    div.className = 'feedback';
    div.style.marginTop = '10px';
    div.innerHTML = '<strong>Imagens ausentes no preview:</strong><br>' + escapeHtml(parts.join(' — '));
    headerEl.appendChild(div);
  }

  // Splits "some text [IMAGE_CODE_1] more text" into ordered
  // {type:'text'|'image', ...} segments so the layout pass below can walk
  // through them top-to-bottom in the exact order they appear in the post.
  //
  // Matches [IMAGE_CODE_N] (the approved/final post format) AND
  // [CODE_SNIPPET_N] (what an unapproved draft still contains — the
  // specialist's own placeholder, never swapped since that only happens on
  // approval in reviewerNode.ts). Same N in both, same codeImages lookup —
  // this lets the preview render real code images even for a rejected
  // draft, which used to just show the raw "[CODE_SNIPPET_N]" token as
  // plain text with no image at all.
  function splitByPlaceholders(text) {
    var regex = /\\[(?:IMAGE_CODE|CODE_SNIPPET)_(\\d+)\\]/g;
    var segments = [];
    var lastIndex = 0;
    var match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
      }
      segments.push({ type: 'image', index: parseInt(match[1], 10) });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      segments.push({ type: 'text', content: text.slice(lastIndex) });
    }
    return segments;
  }

  // Fetches each referenced image with the auth header (an <img src> can't
  // send custom headers), decodes it into an ImageBitmap, then wraps that in
  // a PixiJS Texture — all done up front so the layout pass below can be
  // fully synchronous.
  function loadAllTextures(segments, imagesByIndex, key) {
    var jobs = segments
      .filter(function (s) { return s.type === 'image'; })
      .map(function (seg) {
        var img = imagesByIndex[seg.index];
        if (!img) { seg.skip = true; return Promise.resolve(); }
        return fetch(img.url, { headers: { 'x-api-key': key } })
          .then(function (res) {
            if (!res.ok) throw new Error('Falha ao buscar imagem ' + img.filename);
            return res.blob();
          })
          .then(function (blob) { return createImageBitmap(blob); })
          .then(function (bitmap) {
            var source = new PIXI.ImageSource({ resource: bitmap });
            seg.texture = new PIXI.Texture({ source: source });
          })
          .catch(function (err) {
            console.warn('Preview: skipping image', img && img.filename, err);
            seg.skip = true;
            seg.loadError = (err && err.message) || String(err);
          });
      });
    return Promise.all(jobs);
  }

  function buildPixiCard(segments, hashtags) {
    canvasContainer.innerHTML = '';
    var CARD_WIDTH = 640;
    var PADDING = 24;
    var contentWidth = CARD_WIDTH - PADDING * 2;

    var app = new PIXI.Application();
    return app.init({
      width: CARD_WIDTH,
      height: 200,
      backgroundColor: 0xffffff,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(function () {
      canvasContainer.appendChild(app.canvas);

      var y = PADDING;
      var textStyle = {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 15,
        fill: 0x1a1a1a,
        wordWrap: true,
        wordWrapWidth: contentWidth,
        lineHeight: 22,
      };

      // First pass: lay everything out with its full, final content so
      // every position/size is correct — this is what decides the card's
      // final height. Nothing is hidden yet.
      var revealQueue = [];
      segments.forEach(function (seg) {
        if (seg.type === 'text') {
          var content = seg.content.replace(/^\\n+|\\n+$/g, '');
          if (!content.trim()) return;
          var t = new PIXI.Text({ text: content, style: textStyle });
          t.x = PADDING;
          t.y = y;
          app.stage.addChild(t);
          y += t.height + 12;
          revealQueue.push({ kind: 'text', obj: t, fullText: content });
        } else if (seg.type === 'image' && seg.texture && !seg.skip) {
          var sprite = new PIXI.Sprite(seg.texture);
          var scale = Math.min(1, contentWidth / seg.texture.width);
          sprite.width = seg.texture.width * scale;
          sprite.height = seg.texture.height * scale;
          sprite.x = PADDING;
          sprite.y = y;
          app.stage.addChild(sprite);
          y += sprite.height + 16;
          revealQueue.push({ kind: 'image', obj: sprite });
        }
      });

      var hashtagContainer = null;
      if (hashtags && hashtags.length > 0) {
        hashtagContainer = layoutHashtags(hashtags, contentWidth);
        hashtagContainer.x = PADDING;
        hashtagContainer.y = y;
        app.stage.addChild(hashtagContainer);
        y += hashtagContainer._contentHeight;
      }

      y += PADDING;
      app.renderer.resize(CARD_WIDTH, Math.max(200, y));

      // Second pass: layout/sizing is locked in now, so hide everything and
      // reveal it top-to-bottom — typewriter for text, fade-in for images,
      // pop-in for hashtags. Positions never change from here on, this is
      // purely visual.
      revealQueue.forEach(function (item) {
        if (item.kind === 'text') { item.obj.text = ''; }
        else { item.obj.alpha = 0; }
      });
      if (hashtagContainer) { hashtagContainer.alpha = 0; hashtagContainer.scale.set(0.95); }

      revealSequentially(revealQueue, 0, function () {
        if (hashtagContainer) popIn(hashtagContainer);
      });
    });
  }

  // Reveals revealQueue items one at a time, only starting the next once
  // the current one's animation finishes — mimics reading the post top to
  // bottom instead of everything popping in at once.
  function revealSequentially(queue, i, onDone) {
    if (i >= queue.length) { onDone(); return; }
    var item = queue[i];
    var goNext = function () { revealSequentially(queue, i + 1, onDone); };
    if (item.kind === 'text') { typewriteText(item.obj, item.fullText, goNext); }
    else { fadeIn(item.obj, goNext); }
  }

  // Reveals characters a few at a time via requestAnimationFrame, scaled so
  // any paragraph length takes roughly the same ~1s regardless of how long
  // the text is (a 800-char paragraph revealing 1 char/frame would take
  // ~13s at 60fps, which drags).
  function typewriteText(textObj, fullText, onDone) {
    var len = fullText.length;
    if (len === 0) { onDone(); return; }
    var charsPerFrame = Math.max(1, Math.ceil(len / 60));
    var shown = 0;
    function step() {
      shown = Math.min(len, shown + charsPerFrame);
      textObj.text = fullText.slice(0, shown);
      if (shown < len) { requestAnimationFrame(step); } else { onDone(); }
    }
    requestAnimationFrame(step);
  }

  function fadeIn(displayObject, onDone) {
    var duration = 300;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      displayObject.alpha = t;
      if (t < 1) { requestAnimationFrame(step); } else { onDone(); }
    }
    requestAnimationFrame(step);
  }

  function popIn(displayObject) {
    var duration = 250;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      displayObject.alpha = t;
      var s = 0.95 + 0.05 * t;
      displayObject.scale.set(s);
      if (t < 1) { requestAnimationFrame(step); }
    }
    requestAnimationFrame(step);
  }

  // Builds hashtags as individual interactive PIXI.Text tokens (not one
  // joined string) so each one can react to hover on its own — manual
  // word-wrap since Pixi containers don't do CSS-style inline flow.
  function layoutHashtags(hashtags, maxWidth) {
    var container = new PIXI.Container();
    var x = 0, rowY = 0;
    var lineHeight = 22;
    var gap = 10;
    hashtags.forEach(function (tag) {
      var style = {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 14,
        fill: 0x0a66c2,
      };
      var t = new PIXI.Text({ text: tag, style: style });
      if (x > 0 && x + t.width > maxWidth) { x = 0; rowY += lineHeight; }
      t.x = x;
      t.y = rowY;
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.on('pointerover', function () { t.style.fill = 0x004182; });
      t.on('pointerout', function () { t.style.fill = 0x0a66c2; });
      container.addChild(t);
      x += t.width + gap;
    });
    container._contentHeight = rowY + lineHeight;
    return container;
  }
})();
</script>
</body>
</html>
`;
}
