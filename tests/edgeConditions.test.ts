import test from 'node:test';
import assert from 'node:assert/strict';
import { routeToSpecialist, routeAfterReview } from '../src/graph/nodes/edgeConditions.ts';
import type { GraphState } from '../src/graph/graph.ts';

test('Edge Conditions - Orquestrador: routeToSpecialist', async (t) => {
  await t.test('Deve rotear para iosSpecialist', () => {
    const state = { niche: 'ios' } as GraphState;
    assert.strictEqual(routeToSpecialist(state), 'iosSpecialist');
  });

  await t.test('Deve rotear para aiSpecialist', () => {
    const state = { niche: 'ai_engineering' } as GraphState;
    assert.strictEqual(routeToSpecialist(state), 'aiSpecialist');
  });
});

test('Edge Conditions - Guardrail do Revisor: routeAfterReview', async (t) => {
  await t.test('Deve avançar se aprovado', () => {
    const state = { reviewFeedback: '', reviewCount: 1, niche: 'node_react' } as GraphState;
    assert.strictEqual(routeAfterReview(state), 'imageExtractor');
  });

  await t.test('Deve forçar saída no limite de revisões', () => {
    const state = { reviewFeedback: 'Still bad', reviewCount: 3, niche: 'ios' } as GraphState;
    assert.strictEqual(routeAfterReview(state), 'imageExtractor');
  });
});
