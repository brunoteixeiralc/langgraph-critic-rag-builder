import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableError } from '../src/services/openrouterService.ts';

// Decides whether generateStructured() retries an OpenRouter call with
// backoff. No network involved — just classifying an error object/message.
test('isRetryableError', async (t) => {
  await t.test('valores vazios não são retryable', () => {
    assert.strictEqual(isRetryableError(undefined), false);
    assert.strictEqual(isRetryableError(null), false);
    assert.strictEqual(isRetryableError({}), false);
  });

  await t.test('status HTTP retryable (429, 500, 502, 503)', () => {
    assert.strictEqual(isRetryableError({ status: 429 }), true);
    assert.strictEqual(isRetryableError({ status: 500 }), true);
    assert.strictEqual(isRetryableError({ status: 502 }), true);
    assert.strictEqual(isRetryableError({ status: 503 }), true);
  });

  await t.test('status HTTP não-retryable (ex: 400)', () => {
    assert.strictEqual(isRetryableError({ status: 400 }), false);
  });

  await t.test('lc_error_code MODEL_RATE_LIMIT é retryable', () => {
    assert.strictEqual(isRetryableError({ lc_error_code: 'MODEL_RATE_LIMIT' }), true);
    assert.strictEqual(isRetryableError({ lc_error_code: 'SOMETHING_ELSE' }), false);
  });

  await t.test('mensagem indicando rate limit/timeout é retryable', () => {
    assert.strictEqual(isRetryableError({ message: 'Rate limit exceeded' }), true);
    assert.strictEqual(isRetryableError({ message: 'Request timeout' }), true);
    assert.strictEqual(isRetryableError({ message: 'ECONNRESET' }), true);
    assert.strictEqual(isRetryableError({ message: 'ETIMEDOUT' }), true);
    assert.strictEqual(isRetryableError({ message: 'HTTP 429 Too Many Requests' }), true);
  });

  await t.test('mensagem genérica não é retryable', () => {
    assert.strictEqual(isRetryableError({ message: 'Invalid API key' }), false);
  });

  await t.test('falha de schema do providerStrategy é retryable', () => {
    assert.strictEqual(
      isRetryableError({
        message: "Failed to parse structured output for tool 'providerStrategy':\n  - Model output did not satisfy the provided response schema..",
      }),
      true,
    );
    assert.strictEqual(isRetryableError({ message: 'Model output did not satisfy the provided response schema' }), true);
  });
});
