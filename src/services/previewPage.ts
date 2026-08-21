/**
 * Serves a single self-contained HTML page (see server.ts's
 * `GET /result/:jobId/preview`) that renders a generated post the way it
 * would actually look on LinkedIn. IMPORTANT: LinkedIn's real composer does
 * NOT support images placed inline between paragraphs — attached images
 * always render as a single gallery block (a swipeable multi-image carousel,
 * up to 9 images) below the ENTIRE text, never interleaved at specific
 * points. So each [IMAGE_CODE_N]/[CODE_SNIPPET_N] placeholder in the text
 * renders as a small inline "chip" (just a text cue marking "code discussed
 * here"), and the real rendered code-snippet images are grouped into one
 * gallery section after the text/hashtags — see buildInlineChip() and
 * buildImageGallery() below. Hashtags render below the text, same as a real
 * post — instead of reading raw JSON.
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
  /* Hidden until a job actually finishes — nothing to copy/download while
     pending/running, and no point cluttering the toolbar before then. */
  #actions { display: none; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  #actions.visible { display: flex; }
  #actions button {
    padding: 8px 14px;
    border: 1px solid #cfcfcf;
    border-radius: 6px;
    background: #fff;
    color: #1a1a1a;
    font-size: 13px;
    cursor: pointer;
  }
  #actions button:hover { background: #f3f2ef; }
  #actions button:disabled { opacity: 0.5; cursor: not-allowed; }
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
    <div id="actions">
      <button id="copyTextBtn" type="button">📋 Copiar texto p/ LinkedIn</button>
      <button id="downloadImagesBtn" type="button">⬇️ Baixar imagens</button>
    </div>
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
  var actionsEl = document.getElementById('actions');
  var copyTextBtn = document.getElementById('copyTextBtn');
  var downloadImagesBtn = document.getElementById('downloadImagesBtn');
  var pollTimer = null;
  // Cached from the last successful handleResult() so the button handlers
  // below don't need to re-fetch /result/:jobId — the data's already here.
  var lastData = null;
  var lastKey = null;
  // Checked at the start of every animation step in typewriteText/fadeIn/
  // popIn below — flipping it makes whichever step is in flight jump
  // straight to its end state instead of waiting out its normal duration.
  // Reset to false at the start of every buildPixiCard() call (new job load).
  var skipAnimation = false;

  loadBtn.addEventListener('click', function () { startPolling(); });
  apiKeyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') startPolling();
  });
  copyTextBtn.addEventListener('click', function () { copyPostText(); });
  downloadImagesBtn.addEventListener('click', function () { downloadAllImages(); });

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

  function handleResult(data, key) {
    if (data.status === 'pending' || data.status === 'running') {
      setStatus('Status: ' + data.status + ' — atualizando a cada 3s...', false);
      showLoadingAnimation();
      pollTimer = setTimeout(function () { poll(key); }, 3000);
      return;
    }
    if (data.status === 'error') {
      hideLoadingAnimation();
      setStatus('Job falhou: ' + data.error, true);
      return;
    }
    hideLoadingAnimation();
    setStatus('Pronto.', false);
    lastData = data;
    lastKey = key;
    actionsEl.classList.add('visible');
    // No point offering "baixar imagens" when there's nothing to download —
    // e.g. a text-only post, or every snippet failed both Carbonara and the
    // Shiki fallback.
    downloadImagesBtn.style.display = (data.codeImages && data.codeImages.length > 0) ? '' : 'none';
    renderHeader(data);
    renderCard(data, key);
  }

  // Turns [IMAGE_CODE_N]/[CODE_SNIPPET_N] into a short inline cue and
  // appends the hashtags — this is what you actually want on the clipboard
  // for pasting into LinkedIn's post composer, where images get attached
  // separately as a single gallery upload, never inline in the text. Used
  // to just delete the placeholders outright, which left the copied text
  // with zero mention that there's code to attach at all. The canvas above
  // renders the same "chip + gallery" model for previewing the layout; this
  // is the "ready to paste" plain-text version.
  function getPlainPostText(data) {
    var text = data.finalPostText || data.unapprovedDraft || '';
    var hasImages = !!(data.codeImages && data.codeImages.length > 0);
    text = text.replace(/\\[(?:IMAGE_CODE|CODE_SNIPPET)_(\\d+)\\]/g, function (_m, n) {
      return '(exemplo ' + n + ' 👇)';
    });
    // LinkedIn's post composer doesn't render Markdown — "**bold**" just
    // shows up as literal asterisks in a real post now. Strip them for the
    // clipboard copy only; the canvas preview above is unaffected (it's
    // showing layout, not what actually gets typed into LinkedIn).
    text = text.replace(/\\*\\*/g, '');
    // A collapsed placeholder that sat on its own line can leave 3+
    // consecutive newlines behind — collapse back down to a normal
    // paragraph break.
    text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
    // LinkedIn can't show the images at the "(exemplo N)" cues above — they
    // only attach as one gallery block. Spell that out once so whoever
    // pastes this remembers to actually upload the images (via "Baixar
    // imagens") in the same numbered order.
    if (hasImages) {
      text += '\\n\\n📎 Imagens dos exemplos de codigo anexadas a este post, na mesma ordem numerada acima.';
    }
    if (data.hashtags && data.hashtags.length > 0) {
      // The Reviewer's hashtags field doesn't always include the leading
      // "#" (seen in production: ["SwiftTesting","iOSDev",...]) — normalize
      // so every copied tag is a real, clickable LinkedIn hashtag.
      var tags = data.hashtags.map(function (tag) {
        tag = String(tag).trim();
        return tag.charAt(0) === '#' ? tag : '#' + tag;
      });
      text += '\\n\\n' + tags.join(' ');
    }
    return text;
  }

  function copyPostText() {
    if (!lastData) return;
    var text = getPlainPostText(lastData);

    function onCopied() { setStatus('Texto copiado! Cole no LinkedIn.', false); }
    function onFailed(err) { setStatus('Erro ao copiar: ' + (err && err.message ? err.message : err), true); }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onCopied).catch(function (err) {
        legacyCopy(text) ? onCopied() : onFailed(err);
      });
    } else {
      legacyCopy(text) ? onCopied() : onFailed(new Error('Clipboard API indisponivel.'));
    }
  }

  // Fallback for contexts where navigator.clipboard is unavailable/blocked
  // (older browsers, some non-HTTPS edge cases) — the old hidden-textarea +
  // execCommand trick. Deprecated but still broadly supported as a fallback.
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // Images are behind requireApiKey, so a plain <a href="..."> can't fetch
  // them (no way to attach a custom header) — fetch each with the key,
  // build an object URL, and trigger the download via a throwaway <a
  // download>. Staggered rather than fired all at once: browsers throttle/
  // block automatic multi-file downloads triggered from a single click past
  // the first one or two.
  function downloadAllImages() {
    if (!lastData || !lastData.codeImages || lastData.codeImages.length === 0) return;
    var images = lastData.codeImages;
    var key = lastKey;
    var index = 0;

    setStatus('Baixando imagens (0/' + images.length + ')...', false);

    function downloadNext() {
      if (index >= images.length) {
        setStatus('Imagens baixadas (' + images.length + '/' + images.length + ').', false);
        return;
      }
      var img = images[index];
      index += 1;
      fetch(img.url, { headers: { 'x-api-key': key } })
        .then(function (res) {
          if (!res.ok) throw new Error('Falha ao buscar ' + img.filename);
          return res.blob();
        })
        .then(function (blob) {
          var objectUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = objectUrl;
          a.download = img.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 2000);
        })
        .catch(function (err) {
          console.warn('Download failed for', img.filename, err);
        })
        .then(function () {
          setStatus('Baixando imagens (' + index + '/' + images.length + ')...', false);
          setTimeout(downloadNext, 250);
        });
    }

    downloadNext();
  }

  // Pulsing placeholder blocks instead of a blank card while waiting.
  // Guarded so it doesn't get re-injected (and its CSS animation restarted)
  // on every 3s poll tick — only the first time we see pending/running.
  // Rotating captions while the job is pending/running — real per-node
  // progress (which LangGraph node is currently executing) isn't exposed by
  // the server today, so these just cycle on a timer to make the wait feel
  // less dead, not to claim actual step-by-step tracking.
  var LOADING_MESSAGES = [
    '🧭 Classificando o topico...',
    '✍️ Escrevendo o rascunho...',
    '🔍 Revisando fatos e codigo...',
    '🎨 Renderizando imagens do codigo...',
    '☕ Ainda trabalhando nisso...',
  ];

  var loadingApp = null;

  // PixiJS loading animation shown instead of a blank/skeleton card while
  // pending/running: a bobbing rocket, a few drifting code-glyph particles,
  // and a caption that rotates through LOADING_MESSAGES. Guarded so a poll
  // tick every 3s while still pending doesn't tear down and rebuild it —
  // only the very first pending/running response should start it.
  function showLoadingAnimation() {
    if (loadingApp) return;
    canvasContainer.innerHTML = '';

    var CARD_WIDTH = 640;
    var CARD_HEIGHT = 260;
    var app = new PIXI.Application();
    loadingApp = app;

    app.init({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      backgroundColor: 0xffffff,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(function () {
      // The job finished (hideLoadingAnimation already ran) before this
      // async init resolved — don't attach an orphaned canvas.
      if (loadingApp !== app) { app.destroy(true, { children: true }); return; }
      canvasContainer.appendChild(app.canvas);

      var centerX = CARD_WIDTH / 2;
      var centerY = 100;

      var glyphs = ['{ }', '</>', '#', 'fn()', ';', '=>', '01', '[]'];
      var particles = [];
      for (var i = 0; i < 9; i++) {
        var g = new PIXI.Text({
          text: glyphs[i % glyphs.length],
          style: { fontFamily: 'Menlo, Consolas, monospace', fontSize: 13 + Math.random() * 6, fill: 0xcfe0f5 },
        });
        g.x = 20 + Math.random() * (CARD_WIDTH - 40);
        g.y = Math.random() * CARD_HEIGHT;
        g.alpha = 0.5 + Math.random() * 0.4;
        g._speed = 0.3 + Math.random() * 0.5;
        app.stage.addChild(g);
        particles.push(g);
      }

      var rocket = new PIXI.Text({ text: '🚀', style: { fontSize: 42 } });
      rocket.anchor.set(0.5);
      rocket.x = centerX;
      rocket.y = centerY;
      app.stage.addChild(rocket);

      var caption = new PIXI.Text({
        text: LOADING_MESSAGES[0],
        style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14, fill: 0x555555 },
      });
      caption.anchor.set(0.5, 0);
      caption.x = centerX;
      caption.y = CARD_HEIGHT - 46;
      app.stage.addChild(caption);

      // Message rotation runs on a plain interval, decoupled from the
      // ticker — no need to tie caption changes to frame timing.
      var msgIndex = 0;
      app._loadingMsgTimer = setInterval(function () {
        msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
        caption.text = LOADING_MESSAGES[msgIndex];
      }, 3500);

      app.ticker.add(function () {
        var t = performance.now() / 1000;
        rocket.y = centerY + Math.sin(t * 1.6) * 8;
        rocket.rotation = Math.sin(t * 1.1) * 0.08;

        particles.forEach(function (p) {
          p.y -= p._speed;
          if (p.y < -20) {
            p.y = CARD_HEIGHT + 10;
            p.x = 20 + Math.random() * (CARD_WIDTH - 40);
          }
        });
      });
    });
  }

  // Stops the interval and destroys the Pixi application so its ticker
  // doesn't keep running in the background once the real card takes over.
  function hideLoadingAnimation() {
    if (!loadingApp) return;
    if (loadingApp._loadingMsgTimer) clearInterval(loadingApp._loadingMsgTimer);
    loadingApp.destroy(true, { children: true });
    loadingApp = null;
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
      // NOTE: this whole <script> block is text inside the outer template
      // literal that builds the HTML page (see renderPreviewPage below) —
      // backslashes here get processed as STRING escapes once, at build
      // time, before this ever becomes real JS source in the browser. A
      // single backslash (\d, \.) is not a recognized string escape, so JS
      // silently drops it: the literal that shipped for months was actually
      // /snippet_(d+).png$/ — matching literal "d" characters, not digits —
      // so this ALWAYS failed to match a real "snippet_1.png" filename, always
      // fell into the "no match" branch below, and imagesByIndex stayed empty.
      // That's the actual root cause of "images generated but preview shows
      // none": confirmed by comparing a real /result/:jobId response (codeImages
      // correctly populated) against the browser never issuing a single
      // /images/:filename request. Every backslash meant for the BROWSER's
      // regex must be doubled (\\d, \\.) so it survives this outer escaping —
      // splitByPlaceholders' regex below already does this correctly; this
      // one didn't.
      var match = /snippet_(\\d+)\\.png$/.exec(img.filename || '');
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
        return buildPixiCard(segments, data.hashtags || [], data.niche);
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
    if (neverGenerated.length > 0) parts.push('Sem imagem gerada (Carbonara e fallback Shiki falharam): [' + neverGenerated.join(', ') + ']');
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
        seg.source = img.source; // 'carbonara' | 'shiki' — read by the badge in buildPixiCard below
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

  // No official number is published for where LinkedIn's feed clips a post
  // behind "...ver mais" — this is the figure most commonly cited by
  // LinkedIn growth/SSI tooling and roughly matches the "max 2-3 lines per
  // paragraph" rule the specialist prompts already write toward. Treat the
  // guide line drawn from this as an estimate, not a guarantee: the real
  // cutoff also depends on font, viewport width, and the poster's name/
  // headline length in the feed, none of which this preview can know.
  var LINKEDIN_TRUNCATE_CHARS = 210;

  // Generic per-niche headline shown under the fake name in the profile
  // header — not a claim about who actually wrote the post (this tool has
  // no concept of "author"), just enough real-feed texture to make the
  // mockup read as an actual LinkedIn post instead of a bare text+image card.
  var NICHE_HEADLINES = {
    ios: 'iOS Developer',
    node_react: 'Full Stack Developer',
    ai_engineering: 'AI Engineer',
  };

  function buildPixiCard(segments, hashtags, niche) {
    canvasContainer.innerHTML = '';
    // A fresh render (new job, or a reload of the same one) should always
    // start with the reveal animation intact — without this, clicking
    // "pular animação" on one job would silently skip the animation on
    // every job loaded afterward too.
    skipAnimation = false;
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

      // --- Fake LinkedIn header: avatar, name, headline, connection degree,
      // timestamp — always fully visible immediately (real post chrome
      // doesn't "type itself in"), only the generated content below animates.
      var profileHeader = buildProfileHeader(niche, contentWidth);
      profileHeader.x = PADDING;
      profileHeader.y = y;
      app.stage.addChild(profileHeader);
      y += profileHeader._h + 14;

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
      var charsSoFar = 0; // running count of visible body-text characters, for the LinkedIn-cutoff marker below
      var truncateY = null;
      // Every image segment gets pushed here regardless of whether its
      // texture actually loaded — filtered down to the successful ones right
      // before buildImageGallery() below. Order matches the order the
      // placeholders appear in the text, same as LinkedIn preserves upload
      // order in a real gallery.
      var galleryImages = [];
      segments.forEach(function (seg) {
        if (seg.type === 'text') {
          var content = seg.content.replace(/^\\n+|\\n+$/g, '');
          if (!content.trim()) return;
          var t = new PIXI.Text({ text: content, style: textStyle });
          t.x = PADDING;
          t.y = y;
          app.stage.addChild(t);

          // The threshold falls inside THIS paragraph — approximate where,
          // vertically, by assuming characters are spread evenly across the
          // lines PixiJS wrapped this paragraph into (t.height / lineHeight
          // lines). Not pixel-exact (real line breaks land on word
          // boundaries, not a fixed char count), but close enough to be a
          // useful guide, and avoids depending on PixiJS's internal
          // (undocumented, version-fragile) per-line text metrics.
          if (truncateY === null && charsSoFar + content.length >= LINKEDIN_TRUNCATE_CHARS) {
            var localOffset = LINKEDIN_TRUNCATE_CHARS - charsSoFar;
            var numLines = Math.max(1, Math.round(t.height / textStyle.lineHeight));
            var charsPerLine = Math.max(1, content.length / numLines);
            var lineIndex = Math.min(numLines - 1, Math.floor(localOffset / charsPerLine));
            truncateY = t.y + (lineIndex + 1) * textStyle.lineHeight;
          }
          charsSoFar += content.length;

          y += t.height + 12;
          revealQueue.push({ kind: 'text', obj: t, fullText: content });
        } else if (seg.type === 'image') {
          // LinkedIn has no inline-image support in the real composer — the
          // actual picture only ever shows up as one attached gallery block
          // below the whole text (see buildImageGallery below). Inline, all
          // an honest placeholder can become is a small text cue marking
          // "there's a code example discussed here", not the picture itself.
          galleryImages.push(seg);
          var available = !!(seg.texture && !seg.skip);
          var chip = buildInlineChip(seg.index, available);
          chip.x = PADDING;
          chip.y = y;
          app.stage.addChild(chip);
          y += chip._h + 12;
          revealQueue.push({ kind: 'image', obj: chip });
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

      // The real attached-media block: every code image that actually
      // rendered (Carbonara or the Shiki fallback), grouped as one gallery
      // — this is what a real LinkedIn multi-image post looks like (a
      // single swipeable block below the text), not an image per placeholder
      // position. Sits after the text/hashtags and before the action bar,
      // matching where LinkedIn renders attached media.
      var galleryContainer = null;
      var loadedGalleryImages = galleryImages.filter(function (s) { return s.texture && !s.skip; });
      if (loadedGalleryImages.length > 0) {
        // Breathing room so the gallery doesn't sit flush against the
        // hashtags right above it.
        y += 16;
        galleryContainer = buildImageGallery(loadedGalleryImages, contentWidth);
        galleryContainer.x = PADDING;
        galleryContainer.y = y;
        app.stage.addChild(galleryContainer);
        y += galleryContainer._h + 8;
      }

      // Only draw the cutoff marker if the post is actually long enough to
      // hit it — a short post that never reaches LINKEDIN_TRUNCATE_CHARS
      // never gets clipped in the real feed, so there's nothing to flag.
      var truncateMarker = null;
      if (truncateY !== null) {
        truncateMarker = buildTruncateMarker(PADDING, PADDING + contentWidth, truncateY);
        app.stage.addChild(truncateMarker);
      }

      // --- Fake action bar (Like/Comment/Repost/Send) — same as the header,
      // always fully visible immediately, no reveal animation.
      y += 10;
      var actionBar = buildActionBar(contentWidth, y);
      actionBar.x = PADDING;
      app.stage.addChild(actionBar);
      y += actionBar._h;

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
      if (galleryContainer) { galleryContainer.alpha = 0; }
      // The cutoff line is an annotation ABOUT the post, not part of it —
      // revealed last, after the reader has already "read" the whole card,
      // instead of competing with the typewriter/fade-in for attention.
      if (truncateMarker) { truncateMarker.alpha = 0; }

      revealSequentially(revealQueue, 0, function () {
        if (hashtagContainer) popIn(hashtagContainer);
        if (galleryContainer) fadeIn(galleryContainer, function () {});
        if (truncateMarker) fadeIn(truncateMarker, function () {});
      });
    });
  }

  // Fake LinkedIn post header: avatar circle with initials, name, a
  // niche-derived headline, connection degree, and a fake timestamp. Purely
  // cosmetic chrome — this tool has no real "author" concept, the goal is
  // just to make the card read as an actual feed post instead of a bare
  // text+image rectangle.
  function buildProfileHeader(niche, width) {
    var container = new PIXI.Container();
    var AVATAR_SIZE = 48;

    var avatarBg = new PIXI.Graphics();
    avatarBg.circle(AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2).fill({ color: 0x0a66c2 });
    container.addChild(avatarBg);

    var initials = new PIXI.Text({
      text: 'VC',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 16, fontWeight: 'bold', fill: 0xffffff },
    });
    initials.anchor.set(0.5);
    initials.x = AVATAR_SIZE / 2;
    initials.y = AVATAR_SIZE / 2;
    container.addChild(initials);

    var textX = AVATAR_SIZE + 12;

    var nameText = new PIXI.Text({
      text: 'Seu Nome',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14, fontWeight: 'bold', fill: 0x1a1a1a },
    });
    nameText.x = textX;
    nameText.y = 0;
    container.addChild(nameText);

    var headline = (NICHE_HEADLINES[niche] || 'Software Developer') + ' • 1º';
    var headlineText = new PIXI.Text({
      text: headline,
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fill: 0x666666 },
    });
    headlineText.x = textX;
    headlineText.y = 18;
    container.addChild(headlineText);

    var timeText = new PIXI.Text({
      text: '2h • 🌐',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fill: 0x666666 },
    });
    timeText.x = textX;
    timeText.y = 34;
    container.addChild(timeText);

    container._h = AVATAR_SIZE;
    return container;
  }

  // Fake action bar (Like/Comment/Repost/Send) below the hashtags — same
  // rationale as buildProfileHeader: real feed chrome, not generated
  // content, so it's not part of the reveal animation either.
  function buildActionBar(width, yPos) {
    var container = new PIXI.Container();

    var divider = new PIXI.Graphics();
    divider.moveTo(0, 0).lineTo(width, 0).stroke({ width: 1, color: 0xe0dfdc });
    container.addChild(divider);

    var actions = ['👍 Gostei', '💬 Comentar', '🔁 Compartilhar', '✉️ Enviar'];
    var slotWidth = width / actions.length;
    actions.forEach(function (label, i) {
      var t = new PIXI.Text({
        text: label,
        style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fill: 0x666666 },
      });
      t.x = i * slotWidth + Math.max(0, (slotWidth - t.width) / 2);
      t.y = 14;
      container.addChild(t);
    });

    container.y = yPos;
    container._h = 44;
    return container;
  }

  // Small pill badge on a code-snippet image showing which renderer
  // actually produced it — Carbonara (the primary path, carbon.now.sh via
  // headless Chromium) or the local Shiki fallback (see
  // imageExtractorNode.ts). Answers "which one rendered this?" directly on
  // the card instead of needing to dig through Railway logs for it.
  function buildEngineBadge(source) {
    var isCarbonara = source === 'carbonara';
    var label = isCarbonara ? 'Carbonara' : 'Shiki (fallback)';
    var color = isCarbonara ? 0x0a66c2 : 0x7c3aed;
    var container = new PIXI.Container();

    var text = new PIXI.Text({
      text: label,
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 10, fontWeight: 'bold', fill: 0xffffff },
    });
    text.x = 6;
    text.y = 3;

    var w = text.width + 12;
    var h = text.height + 6;
    var bg = new PIXI.Graphics();
    bg.roundRect(0, 0, w, h, h / 2).fill({ color: color, alpha: 0.9 });

    container.addChild(bg);
    container.addChild(text);
    container._w = w;
    container._h = h;
    return container;
  }

  // Small pill rendered inline where a [IMAGE_CODE_N]/[CODE_SNIPPET_N]
  // placeholder sits in the text. LinkedIn can't actually show an image at
  // this exact spot (see the file header comment), so this is deliberately
  // just a text cue — "there's a code example discussed here, see image N
  // in the gallery below" — not a picture. Greyed out if that image never
  // rendered (Carbonara + Shiki fallback both failed) so it doesn't promise
  // something the gallery below won't actually have.
  function buildInlineChip(index, available) {
    var color = available ? 0x0a66c2 : 0x999999;
    var label = (available ? '🖼️' : '⚠️') + ' Exemplo ' + index + (available ? '' : ' (imagem indisponivel)');
    var container = new PIXI.Container();

    var text = new PIXI.Text({
      text: label,
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fontWeight: 'bold', fill: color },
    });
    text.x = 10;
    text.y = 5;

    var w = text.width + 20;
    var h = text.height + 10;
    var bg = new PIXI.Graphics();
    bg.roundRect(0, 0, w, h, h / 2).fill({ color: color, alpha: 0.1 });
    bg.stroke({ width: 1, color: color, alpha: 0.4 });

    container.addChild(bg);
    container.addChild(text);
    container._w = w;
    container._h = h;
    return container;
  }

  // The real attached-media block, laid out the way LinkedIn's own
  // multi-image gallery reads: small numbered thumbnails in a row (wrapping
  // after 3 per row so it doesn't get too cramped), each with its engine
  // badge. This is what the reader would actually see below the text on a
  // real LinkedIn post — not one full-size image per paragraph.
  function buildImageGallery(segs, maxWidth) {
    var container = new PIXI.Container();
    var GAP = 10;
    var perRow = Math.min(3, segs.length);
    var thumbWidth = Math.floor((maxWidth - GAP * (perRow - 1)) / perRow);

    var heading = new PIXI.Text({
      text: '🖼️ Imagens anexadas (' + segs.length + ')',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fontWeight: 'bold', fill: 0x666666 },
    });
    container.addChild(heading);

    var rowY = heading.height + 8;
    var col = 0, rowX = 0, rowMaxH = 0;
    segs.forEach(function (seg) {
      var scale = thumbWidth / seg.texture.width;
      var sprite = new PIXI.Sprite(seg.texture);
      sprite.width = thumbWidth;
      sprite.height = seg.texture.height * scale;

      var group = new PIXI.Container();
      group.addChild(sprite);

      // NOTE: no JS-drawn number circle here on purpose — imageExtractorNode.ts
      // now bakes the "N" badge directly into the PNG pixels server-side (see
      // addNumberBadge there), because that's the only thing that survives
      // once the image is uploaded to LinkedIn's own gallery (filenames and
      // any canvas-only annotation are lost at that point). Drawing a second
      // number here would just double up on top of the real one.

      if (seg.source) {
        var badge = buildEngineBadge(seg.source);
        badge.x = sprite.width - badge._w - 6;
        badge.y = 6;
        group.addChild(badge);
      }

      group.x = rowX;
      group.y = rowY;
      container.addChild(group);

      rowMaxH = Math.max(rowMaxH, sprite.height);
      rowX += thumbWidth + GAP;
      col += 1;
      if (col >= perRow) {
        col = 0;
        rowX = 0;
        rowY += rowMaxH + GAP;
        rowMaxH = 0;
      }
    });
    if (col !== 0) rowY += rowMaxH + GAP;

    container._h = rowY;
    return container;
  }

  // Draws a dashed guide line + label at the vertical point where LinkedIn's
  // feed would clip the post behind "...ver mais" (see LINKEDIN_TRUNCATE_CHARS
  // above for the caveats on how approximate this is). A handful of short
  // moveTo/lineTo segments before a single stroke() call is the standard way
  // to fake a dashed line in PixiJS v8 — there's no native dash support, but
  // this is well within the segment count where that approach is fine (the
  // library only struggles at very high segment counts, not the ~60 a single
  // card-width line needs here).
  function buildTruncateMarker(x0, x1, yPos) {
    var container = new PIXI.Container();
    var color = 0xd97706;

    var line = new PIXI.Graphics();
    var dash = 6, gap = 4, x = x0;
    while (x < x1) {
      var segEnd = Math.min(x1, x + dash);
      line.moveTo(x, yPos).lineTo(segEnd, yPos);
      x = segEnd + gap;
    }
    line.stroke({ width: 1.5, color: color });
    container.addChild(line);

    var label = new PIXI.Text({
      text: '✂️ corte do feed (~' + LINKEDIN_TRUNCATE_CHARS + ' car., estimativa) — "ver mais"',
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 11,
        fontStyle: 'italic',
        fill: 0x7a4a03,
      },
    });
    label.x = x0 + 4;
    label.y = yPos + 4;

    // The dashed line crosses right through live post text — the label
    // needs its own solid backing to stay readable instead of blending into
    // whatever paragraph it happens to land near.
    var labelBg = new PIXI.Graphics();
    labelBg
      .roundRect(x0, yPos + 2, label.width + 8, label.height + 4, 4)
      .fill({ color: 0xfff7e6, alpha: 0.95 });
    labelBg.stroke({ width: 1, color: color, alpha: 0.6 });
    container.addChild(labelBg);
    container.addChild(label);

    return container;
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
    if (len === 0 || skipAnimation) { textObj.text = fullText; onDone(); return; }
    var charsPerFrame = Math.max(1, Math.ceil(len / 60));
    var shown = 0;
    function step() {
      if (skipAnimation) { textObj.text = fullText; onDone(); return; }
      shown = Math.min(len, shown + charsPerFrame);
      textObj.text = fullText.slice(0, shown);
      if (shown < len) { requestAnimationFrame(step); } else { onDone(); }
    }
    requestAnimationFrame(step);
  }

  function fadeIn(displayObject, onDone) {
    if (skipAnimation) { displayObject.alpha = 1; onDone(); return; }
    var duration = 300;
    var start = null;
    function step(ts) {
      if (skipAnimation) { displayObject.alpha = 1; onDone(); return; }
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      displayObject.alpha = t;
      if (t < 1) { requestAnimationFrame(step); } else { onDone(); }
    }
    requestAnimationFrame(step);
  }

  function popIn(displayObject) {
    if (skipAnimation) { displayObject.alpha = 1; displayObject.scale.set(1); return; }
    var duration = 250;
    var start = null;
    function step(ts) {
      if (skipAnimation) { displayObject.alpha = 1; displayObject.scale.set(1); return; }
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
