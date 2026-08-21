/**
 * Serves a small self-contained HTML page (see server.ts's `GET /`) that
 * replaces the manual curl workflow for kicking off a new post:
 *
 *   curl -X POST https://.../generate -H "x-api-key: ..." \
 *     -d '{"topic": "..."}'
 *
 * with a form (x-api-key + topic textarea) that POSTs to /generate itself
 * and redirects to the resulting job's /preview page. Same auth model as
 * previewPage.ts: this page's HTML is static and holds no secrets — it's
 * not behind requireApiKey (a browser navigating here can't attach a
 * custom header anyway) — the key is only ever used client-side, from a
 * password field, for the authenticated fetch() call below.
 *
 * The key is cached in localStorage (key: "lcrb_api_key") purely as a
 * convenience so it doesn't have to be re-pasted on every visit, and
 * previewPage.ts reads the same key so the redirect after generating lands
 * on an already-authenticated preview instead of asking for the key again.
 * This is a real page served to the user's own browser (not the Claude
 * conversation's sandboxed artifact preview), so normal browser storage is
 * fine here.
 *
 * PixiJS additions (this was a plain static form before): an ambient
 * animated background, a "fuel gauge" style bar for the topic character
 * count, the niche selector rebuilt as clickable cards, and a rocket-launch
 * animation that plays right after a job is created, before redirecting to
 * the preview — same rationale as the loading animation already built into
 * previewPage.ts (see showLoadingAnimation there): makes an otherwise dead
 * waiting moment feel like part of the app instead of a stalled form.
 */
export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gerar novo post — LangGraph Critic-RAG</title>
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
  #bgCanvas {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
  }
  #bgCanvas canvas { display: block; }
  .card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 640px;
    background: #fff;
    border: 1px solid #e0dfdc;
    border-radius: 8px;
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { font-size: 13px; color: #666; margin: 0 0 20px; line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type="password"], textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #cfcfcf;
    border-radius: 6px;
    font-size: 14px;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 140px; line-height: 1.5; }
  .field { margin-bottom: 16px; }
  .hint { font-size: 12px; color: #888; margin-top: 4px; }
  .charBarWrap { margin-top: 8px; }
  .charBarWrap canvas { display: block; }
  .charCount { font-size: 12px; color: #888; text-align: right; margin-top: 4px; }
  button {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    background: #0a66c2;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #004182; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  button.secondary {
    background: #fff;
    color: #0a66c2;
    border: 1px solid #0a66c2;
    width: 100%;
    margin-top: 10px;
  }
  button.secondary:hover { background: #eef3f8; }
  .divider {
    border: none;
    border-top: 1px solid #e0dfdc;
    margin: 24px 0 20px;
  }
  #nicheCardsWrap { margin-top: 2px; }
  #nicheCardsWrap canvas { display: block; }
  #launchWrap { display: none; margin-top: 14px; }
  #launchWrap canvas { display: block; }
  #status { margin-top: 14px; font-size: 13px; color: #555; min-height: 18px; line-height: 1.5; }
  #status.error { color: #c0392b; }
</style>
</head>
<body>

  <div id="bgCanvas"></div>

  <div class="card">
    <h1>🚀 Gerar novo post</h1>
    <p class="subtitle">Substitui o curl manual — cole sua chave e o tópico/comando (pode incluir uma URL de referência dentro do texto), o resto do pipeline roda sozinho.</p>

    <div class="field">
      <label for="apiKey">x-api-key</label>
      <input id="apiKey" type="password" placeholder="Cole sua x-api-key aqui" autocomplete="off">
      <div class="hint">Fica salva só no seu navegador (localStorage) — não é enviada a mais ninguém.</div>
    </div>

    <div class="field">
      <label for="topic">Tópico / comando</label>
      <textarea id="topic" maxlength="2000" placeholder="Ex: Explique as novidades do Swift Testing, com exemplos de codigo, baseado neste artigo: https://..."></textarea>
      <div id="charBarWrap" class="charBarWrap"></div>
      <div class="charCount"><span id="charCount">0</span>/2000</div>
    </div>

    <button id="generateBtn" type="button">Gerar post</button>
    <div id="launchWrap"></div>

    <hr class="divider">

    <div class="field">
      <label>Teste rápido (sem custo, sem chamar o LLM)</label>
      <div id="nicheCardsWrap"></div>
      <button id="mockBtn" type="button" class="secondary">Gerar mock</button>
      <div class="hint">Usa conteudo fixo de exemplo pra testar preview/imagens/layout sem gastar tokens de LLM.</div>
    </div>

    <div id="status"></div>
  </div>

<script>
(function () {
  var STORAGE_KEY = 'lcrb_api_key';
  var MAX_TOPIC_LENGTH = 2000;
  var apiKeyInput = document.getElementById('apiKey');
  var topicInput = document.getElementById('topic');
  var charCount = document.getElementById('charCount');
  var generateBtn = document.getElementById('generateBtn');
  var mockBtn = document.getElementById('mockBtn');
  var statusEl = document.getElementById('status');
  var bgCanvasEl = document.getElementById('bgCanvas');
  var charBarWrap = document.getElementById('charBarWrap');
  var nicheCardsWrap = document.getElementById('nicheCardsWrap');
  var launchWrap = document.getElementById('launchWrap');

  // Which niche card is currently picked for "Gerar mock" — the cards
  // below (initNicheCards) update this directly on click instead of a
  // hidden <select>, PixiJS render objects don't have form values.
  var selectedNiche = 'ios';

  try {
    var savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) { apiKeyInput.value = savedKey; }
  } catch (e) { /* localStorage unavailable (private browsing, etc) — just skip prefill */ }

  topicInput.addEventListener('input', function () {
    var len = topicInput.value.length;
    charCount.textContent = String(len);
    setCharBarTarget(len / MAX_TOPIC_LENGTH);
  });

  topicInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitGenerate();
  });

  generateBtn.addEventListener('click', function () { submitGenerate(); });
  mockBtn.addEventListener('click', function () { submitMock(); });

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'error' : '';
  }

  function requireKey() {
    var key = apiKeyInput.value.trim();
    if (!key) { setStatus('Cole sua x-api-key acima.', true); return null; }
    try { localStorage.setItem(STORAGE_KEY, key); } catch (e) { /* ignore */ }
    return key;
  }

  // Shared by both buttons — POSTs to whichever endpoint, disables the
  // triggering button while in flight, plays the launch animation, then
  // redirects to the returned previewUrl. /generate and /generate-mock both
  // return the exact same { jobId, statusUrl, previewUrl } shape, so this
  // needs no per-endpoint branching beyond the URL/body/button passed in.
  function submitJob(url, body, triggerBtn) {
    triggerBtn.disabled = true;
    setStatus('Enviando...', false);

    var key = body.__key;
    delete body.__key;

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (r) {
        if (!r.ok) {
          var msg = (r.data && r.data.error) ? r.data.error : ('Erro HTTP ' + r.status);
          setStatus(msg, true);
          triggerBtn.disabled = false;
          return;
        }
        setStatus('Job criado!', false);
        playLaunchAnimation(function () {
          window.location.href = r.data.previewUrl;
        });
      })
      .catch(function (err) {
        setStatus('Erro de rede: ' + err.message, true);
        triggerBtn.disabled = false;
      });
  }

  function submitGenerate() {
    var key = requireKey();
    if (!key) return;
    var topic = topicInput.value.trim();
    if (!topic) { setStatus('Escreva o topico/comando.', true); return; }
    submitJob('/generate', { topic: topic, __key: key }, generateBtn);
  }

  function submitMock() {
    var key = requireKey();
    if (!key) return;
    submitJob('/generate-mock', { niche: selectedNiche, __key: key }, mockBtn);
  }

  // ---------------- PixiJS: ambient background ----------------
  // Purely decorative — drifting code glyphs behind the card, with the
  // whole layer nudged slightly toward the mouse for a cheap parallax feel.
  // Fixed to the viewport (not the document), independent PIXI.Application
  // from every other canvas on this page — its lifecycle never needs to
  // interact with the form logic above.
  (function initAmbientBackground() {
    var app = new PIXI.Application();
    app.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(function () {
      bgCanvasEl.appendChild(app.canvas);

      var layer = new PIXI.Container();
      app.stage.addChild(layer);

      var glyphs = ['{ }', '</>', '#', 'fn()', ';', '=>', '01', '[]', '&&'];
      var particles = [];
      var count = Math.max(16, Math.min(34, Math.round((window.innerWidth * window.innerHeight) / 45000)));
      for (var i = 0; i < count; i++) {
        var g = new PIXI.Text({
          text: glyphs[i % glyphs.length],
          style: { fontFamily: 'Menlo, Consolas, monospace', fontSize: 12 + Math.random() * 10, fill: 0xd7e3f0 },
        });
        g.x = Math.random() * window.innerWidth;
        g.y = Math.random() * window.innerHeight;
        g.alpha = 0.25 + Math.random() * 0.35;
        g._speed = 0.15 + Math.random() * 0.35;
        layer.addChild(g);
        particles.push(g);
      }

      var mouseX = window.innerWidth / 2;
      window.addEventListener('mousemove', function (e) { mouseX = e.clientX; });

      app.ticker.add(function () {
        var targetParallax = (mouseX - window.innerWidth / 2) * 0.02;
        layer.x += (targetParallax - layer.x) * 0.05;
        particles.forEach(function (p) {
          p.y -= p._speed;
          if (p.y < -20) {
            p.y = window.innerHeight + 20;
            p.x = Math.random() * window.innerWidth;
          }
        });
      });

      window.addEventListener('resize', function () {
        app.renderer.resize(window.innerWidth, window.innerHeight);
      });
    });
  })();

  // ---------------- PixiJS: topic character "fuel gauge" bar ----------------
  // Visual stand-in for the plain "N/2000" counter — fills left to right as
  // you type, shifting blue -> amber -> red near the limit. Smoothed toward
  // its target width each frame instead of snapping, so it reads as a live
  // gauge rather than a jumpy progress bar.
  var charBarTargetWidth = 0;
  var charBarTrackWidth = 0;
  var charBarFill = null;

  (function initCharBar() {
    var app = new PIXI.Application();
    var trackWidth = Math.max(200, charBarWrap.clientWidth || 300);
    charBarTrackWidth = trackWidth;
    app.init({
      width: trackWidth,
      height: 8,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(function () {
      charBarWrap.appendChild(app.canvas);

      var track = new PIXI.Graphics();
      track.roundRect(0, 0, trackWidth, 6, 3).fill({ color: 0xe5e7eb });
      app.stage.addChild(track);

      charBarFill = new PIXI.Graphics();
      charBarFill._currentWidth = 0;
      app.stage.addChild(charBarFill);

      app.ticker.add(function () {
        var current = charBarFill._currentWidth;
        var next = current + (charBarTargetWidth - current) * 0.18;
        if (Math.abs(next - current) < 0.3) next = charBarTargetWidth;
        charBarFill._currentWidth = next;
        charBarFill.clear();
        if (next > 0.5) {
          charBarFill.roundRect(0, 0, Math.min(trackWidth, next), 6, 3).fill({ color: charBarColor(next / trackWidth) });
        }
      });
    });
  })();

  function charBarColor(ratio) {
    if (ratio > 0.85) return 0xc0392b;
    if (ratio > 0.6) return 0xd97706;
    return 0x0a66c2;
  }

  function setCharBarTarget(ratio) {
    charBarTargetWidth = Math.max(0, Math.min(1, ratio)) * charBarTrackWidth;
  }

  // ---------------- PixiJS: niche selector cards ----------------
  // Replaces the old plain <select> with 3 clickable cards — selectedNiche
  // (declared above) is what submitMock() actually reads; there's no
  // underlying <select> element anymore.
  (function initNicheCards() {
    var NICHES = [
      { id: 'ios', label: 'iOS', icon: '🍎' },
      { id: 'node_react', label: 'Node / React', icon: '⚛️' },
      { id: 'ai_engineering', label: 'AI Engineering', icon: '🤖' },
    ];
    var app = new PIXI.Application();
    var width = Math.max(280, nicheCardsWrap.clientWidth || 592);
    var height = 76;
    app.init({
      width: width,
      height: height,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(function () {
      nicheCardsWrap.appendChild(app.canvas);

      var GAP = 10;
      var cardWidth = (width - GAP * 2) / 3;
      var cards = [];

      NICHES.forEach(function (niche, i) {
        var card = buildNicheCard(niche, cardWidth, height);
        card.x = i * (cardWidth + GAP);
        card.y = 0;
        app.stage.addChild(card);
        cards.push(card);
      });

      function refreshSelection() {
        cards.forEach(function (card) { card._setSelected(card._niche.id === selectedNiche); });
      }
      refreshSelection();

      cards.forEach(function (card) {
        card.on('pointertap', function () {
          selectedNiche = card._niche.id;
          refreshSelection();
        });
      });
    });
  })();

  function buildNicheCard(niche, w, h) {
    var container = new PIXI.Container();
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container._niche = niche;
    container._selected = false;

    var bg = new PIXI.Graphics();
    container.addChild(bg);

    var icon = new PIXI.Text({ text: niche.icon, style: { fontSize: 22 } });
    icon.anchor.set(0.5);
    icon.x = w / 2;
    icon.y = h / 2 - 12;
    container.addChild(icon);

    var label = new PIXI.Text({
      text: niche.label,
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0x1a1a1a },
    });
    label.anchor.set(0.5, 0);
    label.x = w / 2;
    label.y = h / 2 + 8;
    container.addChild(label);

    function draw(selected, hover) {
      bg.clear();
      var fillColor = selected ? 0xeef3f8 : 0xffffff;
      var strokeColor = selected ? 0x0a66c2 : 0xd8dade;
      bg.roundRect(1, 1, w - 2, h - 2, 10).fill({ color: fillColor });
      bg.stroke({ width: selected ? 2 : 1, color: strokeColor });
      label.style.fill = selected ? 0x0a66c2 : 0x1a1a1a;
      container.scale.set(hover && !selected ? 1.03 : 1);
    }

    container._setSelected = function (selected) {
      container._selected = !!selected;
      draw(container._selected, false);
    };
    container.on('pointerover', function () { draw(container._selected, true); });
    container.on('pointerout', function () { draw(container._selected, false); });

    draw(false, false);
    return container;
  }

  // ---------------- PixiJS: rocket launch on submit ----------------
  // Plays once a job is successfully created, replacing the old plain
  // "redirecting..." pause — a rocket accelerates off the top of a small
  // canvas with a fading particle trail, then the redirect fires. Same
  // "make the wait feel like part of the app" idea as previewPage.ts's
  // showLoadingAnimation, just a one-shot celebration instead of a loop.
  function playLaunchAnimation(onDone) {
    launchWrap.style.display = 'block';
    launchWrap.innerHTML = '';

    var width = Math.max(280, launchWrap.clientWidth || 592);
    var height = 140;
    var app = new PIXI.Application();
    app.init({
      width: width,
      height: height,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(function () {
      launchWrap.appendChild(app.canvas);

      var caption = new PIXI.Text({
        text: 'Gerando...',
        style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 13, fill: 0x555555 },
      });
      caption.anchor.set(0.5, 0);
      caption.x = width / 2;
      caption.y = 6;
      app.stage.addChild(caption);

      var rocket = new PIXI.Text({ text: '🚀', style: { fontSize: 36 } });
      rocket.anchor.set(0.5);
      rocket.x = width / 2;
      var startY = height - 18;
      rocket.y = startY;
      app.stage.addChild(rocket);

      var particles = [];
      var duration = 900;
      var start = null;
      var doneCalled = false;

      function spawnTrailParticle() {
        var p = new PIXI.Graphics();
        var r = 2 + Math.random() * 2;
        p.circle(0, 0, r).fill({ color: 0xff9d4d, alpha: 0.85 });
        p.x = rocket.x + (Math.random() - 0.5) * 10;
        p.y = rocket.y + 16;
        p._vy = 1 + Math.random() * 1.5;
        p._life = 1;
        app.stage.addChildAt(p, 0);
        particles.push(p);
      }

      app.ticker.add(function () {
        var now = performance.now();
        if (start === null) start = now;
        var t = Math.min(1, (now - start) / duration);
        var eased = t * t; // ease-in — accelerates like a real launch
        rocket.y = startY - eased * (height + 30);
        rocket.rotation = Math.sin(t * 24) * 0.03;

        if (t < 1 && Math.random() < 0.6) spawnTrailParticle();

        for (var i = particles.length - 1; i >= 0; i--) {
          var p = particles[i];
          p.y += p._vy;
          p._life -= 0.03;
          p.alpha = Math.max(0, p._life);
          if (p._life <= 0) {
            app.stage.removeChild(p);
            particles.splice(i, 1);
          }
        }

        if (t >= 1 && particles.length === 0 && !doneCalled) {
          doneCalled = true;
          app.ticker.stop();
          setTimeout(function () {
            app.destroy(true, { children: true });
            launchWrap.style.display = 'none';
            launchWrap.innerHTML = '';
            onDone();
          }, 120);
        }
      });
    });
  }
})();
</script>
</body>
</html>
`;
}
