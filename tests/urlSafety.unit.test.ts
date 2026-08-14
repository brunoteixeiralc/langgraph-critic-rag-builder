import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUrlIsSafeToFetch } from '../src/services/urlSafety.ts';

// SSRF guard for any URL the app fetches server-side (topic-embedded links,
// index-page expansion). These cases don't need real DNS — either the
// hostname is a literal IP (checked directly) or the protocol is rejected
// before a lookup would even happen — so this suite is free/fast/offline.
test('assertUrlIsSafeToFetch', async (t) => {
  await t.test('bloqueia protocolos que não são http/https', async () => {
    assert.strictEqual((await assertUrlIsSafeToFetch('file:///etc/passwd')).safe, false);
    assert.strictEqual((await assertUrlIsSafeToFetch('ftp://example.com/')).safe, false);
    assert.strictEqual((await assertUrlIsSafeToFetch('gopher://example.com/')).safe, false);
  });

  await t.test('bloqueia URL malformada', async () => {
    assert.strictEqual((await assertUrlIsSafeToFetch('not a url')).safe, false);
  });

  await t.test('bloqueia metadata de cloud (169.254.169.254)', async () => {
    const result = await assertUrlIsSafeToFetch('http://169.254.169.254/latest/meta-data/');
    assert.strictEqual(result.safe, false);
  });

  await t.test('bloqueia loopback IPv4 e IPv6', async () => {
    assert.strictEqual((await assertUrlIsSafeToFetch('http://127.0.0.1/')).safe, false);
    assert.strictEqual((await assertUrlIsSafeToFetch('http://[::1]/')).safe, false);
  });

  await t.test('bloqueia faixas privadas RFC1918', async () => {
    assert.strictEqual((await assertUrlIsSafeToFetch('http://10.0.0.5/')).safe, false);
    assert.strictEqual((await assertUrlIsSafeToFetch('http://172.16.0.1/')).safe, false);
    assert.strictEqual((await assertUrlIsSafeToFetch('http://192.168.1.1/')).safe, false);
  });

  await t.test('bloqueia link-local IPv6 (fe80::/10)', async () => {
    assert.strictEqual((await assertUrlIsSafeToFetch('http://[fe80::1]/')).safe, false);
  });

  await t.test('permite IP público literal (sem precisar de DNS)', async () => {
    assert.deepStrictEqual(await assertUrlIsSafeToFetch('http://8.8.8.8/'), { safe: true });
    assert.deepStrictEqual(await assertUrlIsSafeToFetch('https://1.1.1.1/'), { safe: true });
  });
});
