import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drainRoutePoints, retryAsync } from '../src/route-sync-core';

test('repete uma operação transitória antes de desistir', async () => {
  let attempts = 0;
  const result = await retryAsync(async () => { attempts += 1; if (attempts < 3) throw new Error('rede'); return 'ok'; }, 3, 0);
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('drena todos os lotes e só remove pontos confirmados', async () => {
  let queue = Array.from({ length: 205 }, (_, index) => ({ id: String(index), payload: '{}' }));
  const batches: number[] = [];
  const removed: string[] = [];
  const sent = await drainRoutePoints(
    () => queue,
    async batch => { batches.push(batch.length); queue = queue.slice(batch.length); return new Set(batch.map(point => point.id)); },
    ids => { removed.push(...ids); },
  );
  assert.equal(sent, 205);
  assert.deepEqual(batches, [100, 100, 5]);
  assert.equal(removed.length, 205);
  assert.equal(queue.length, 0);
});

test('não remove um lote quando o servidor não confirma todos os pontos', async () => {
  const queue = [{ id: 'a', payload: '{}' }, { id: 'b', payload: '{}' }];
  assert.rejects(() => drainRoutePoints(() => queue, async () => new Set(['a']), () => {}), /todos os pontos/);
});
