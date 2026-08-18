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
        if (!res.ok) throw new Error('Erro HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { handleResult(data, key); })
      .catch(function (err) { setStatus(err.message, true); });
  }

  function handleResult(data, key) {
    if (data.status === 'pending' || data.status === 'running') {
      setStatus('Status: ' + data.status + ' — atualizando a cada 3s...', false);
      pollTimer = setTimeout(function () { poll(key); }, 3000);
      return;
    }
    if (data.status === 'error') {
      setStatus('Job falhou: ' + data.error, true);
      return;
    }
    setStatus('Pronto.', false);
    renderHeader(data);
    renderCard(data, key);
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
    headerEl.innerHTML = html;
  }

  function renderCard(data, key) {
    var text = data.finalPostText || data.unapprovedDraft || '(sem conteudo)';
    var imagesByIndex = {};
    (data.codeImages || []).forEach(function (img, i) {
      imagesByIndex[i + 1] = img; // [IMAGE_CODE_1] -> codeImages[0], 1-indexed placeholders
    });

    var segments = splitByPlaceholders(text);

    loadAllTextures(segments, imagesByIndex, key)
      .then(function () { return buildPixiCard(segments, data.hashtags || []); })
      .catch(function (err) { setStatus('Erro montando o preview: ' + err.message, true); });
  }

  // Splits "some text [IMAGE_CODE_1] more text" into ordered
  // {type:'text'|'image', ...} segments so the layout pass below can walk
  // through them top-to-bottom in the exact order they appear in the post.
  function splitByPlaceholders(text) {
    var regex = /\\[IMAGE_CODE_(\\d+)\\]/g;
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

      segments.forEach(function (seg) {
        if (seg.type === 'text') {
          var content = seg.content.replace(/^\\n+|\\n+$/g, '');
          if (!content.trim()) return;
          var t = new PIXI.Text({ text: content, style: textStyle });
          t.x = PADDING;
          t.y = y;
          app.stage.addChild(t);
          y += t.height + 12;
        } else if (seg.type === 'image' && seg.texture && !seg.skip) {
          var sprite = new PIXI.Sprite(seg.texture);
          var scale = Math.min(1, contentWidth / seg.texture.width);
          sprite.width = seg.texture.width * scale;
          sprite.height = seg.texture.height * scale;
          sprite.x = PADDING;
          sprite.y = y;
          app.stage.addChild(sprite);
          y += sprite.height + 16;
        }
      });

      if (hashtags && hashtags.length > 0) {
        var tagsStyle = {
          fontFamily: 'Arial, Helvetica, sans-serif',
          fontSize: 14,
          fill: 0x0a66c2,
          wordWrap: true,
          wordWrapWidth: contentWidth,
          lineHeight: 20,
        };
        var tagsObj = new PIXI.Text({ text: hashtags.join(' '), style: tagsStyle });
        tagsObj.x = PADDING;
        tagsObj.y = y;
        app.stage.addChild(tagsObj);
        y += tagsObj.height;
      }

      y += PADDING;
      app.renderer.resize(CARD_WIDTH, Math.max(200, y));
    });
  }
})();
</script>
</body>
</html>
`;
}
