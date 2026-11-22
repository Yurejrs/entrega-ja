import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceMeters } from '../src/geo.js';

test('calcula distância aproximada entre coordenadas', () => {
  const distance = distanceMeters({ latitude: -3.7319, longitude: -38.5267 }, { latitude: -3.7329, longitude: -38.5267 });
  assert.ok(distance > 100 && distance < 120, `distância inesperada: ${distance}`);
});

test('retorna zero para o mesmo ponto', () => {
  assert.equal(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
});
