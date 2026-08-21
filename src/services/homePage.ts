/**
 * Serves a small self-contained HTML page (see server.ts's `GET /`) that
 * replaces the manual curl workflow for kicking off a new post:
 *
 *   curl -X POST https://.../generate -H "x-api-key: ..." \
 *     -d '{"topic": "..."}'
 *
 * with a plain form (x-api-key + topic textarea) that POSTs to /generate
 * itself and redirects to the resulting job's /preview page. Same auth
 * model as previewPage.ts: this page's HTML is static and holds no
 * secrets — it's not behind requireApiKey (a browser navigating here can't
 * attach a custom header anyway) — the key is only ever used client-side,
 * from a password field, for the authenticated fetch() call below.
 *
 * The key is cached in localStorage (key: "lcrb_api_key") purely as a
 * convenience so it doesn't have to be re-pasted on every visit, and
 * previewPage.ts reads the same key so the redirect after generating lands
 * on an already-authenticated preview instead of asking for the key again.
 * This is a real page served to the user's own browser (not the Claude
 * conversation's sandboxed artifact preview), so normal browser storage is
 * fine here.
 */
export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gerar novo post — LangGraph Critic-RAG</title>
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
  .card {
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
  }
  button.secondary:hover { background: #eef3f8; }
  select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #cfcfcf;
    border-radius: 6px;
    font-size: 14px;
    font-family: inherit;
    background: #fff;
  }
  .divider {
    border: none;
    border-top: 1px solid #e0dfdc;
    margin: 24px 0 20px;
  }
  .mockRow { display: flex; gap: 10px; align-items: flex-start; }
  .mockRow select { flex: 1; }
  #status { margin-top: 14px; font-size: 13px; color: #555; min-height: 18px; line-height: 1.5; }
  #status.error { color: #c0392b; }
</style>
</head>
<body>

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
      <div class="charCount"><span id="charCount">0</span>/2000</div>
    </div>

    <button id="generateBtn" type="button">Gerar post</button>

    <hr class="divider">

    <div class="field">
      <label for="mockNiche">Teste rápido (sem custo, sem chamar o LLM)</label>
      <div class="mockRow">
        <select id="mockNiche">
          <option value="ios">iOS</option>
          <option value="node_react">Node / React</option>
          <option value="ai_engineering">AI Engineering</option>
        </select>
        <button id="mockBtn" type="button" class="secondary">Gerar mock</button>
      </div>
      <div class="hint">Usa conteudo fixo de exemplo pra testar preview/imagens/layout sem gastar tokens de LLM.</div>
    </div>

    <div id="status"></div>
  </div>

<script>
(function () {
  var STORAGE_KEY = 'lcrb_api_key';
  var apiKeyInput = document.getElementById('apiKey');
  var topicInput = document.getElementById('topic');
  var charCount = document.getElementById('charCount');
  var generateBtn = document.getElementById('generateBtn');
  var mockNicheSelect = document.getElementById('mockNiche');
  var mockBtn = document.getElementById('mockBtn');
  var statusEl = document.getElementById('status');

  try {
    var savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) { apiKeyInput.value = savedKey; }
  } catch (e) { /* localStorage unavailable (private browsing, etc) — just skip prefill */ }

  topicInput.addEventListener('input', function () {
    charCount.textContent = String(topicInput.value.length);
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
  // triggering button while in flight, and redirects to the returned
  // previewUrl on success. /generate and /generate-mock both return the
  // exact same { jobId, statusUrl, previewUrl } shape, so this needs no
  // per-endpoint branching beyond the URL/body/button passed in.
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
        setStatus('Job criado! Redirecionando pro preview...', false);
        setTimeout(function () { window.location.href = r.data.previewUrl; }, 500);
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
    submitJob('/generate-mock', { niche: mockNicheSelect.value, __key: key }, mockBtn);
  }
})();
</script>
</body>
</html>
`;
}
