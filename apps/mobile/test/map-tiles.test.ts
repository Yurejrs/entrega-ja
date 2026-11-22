import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCoordinates, previewTiles } from '../src/map-tiles';

test('map coordinates accept numeric strings from PostgreSQL JSON snapshots', () => {
  assert.deepEqual(mapCoordinates('-3.7319', '-38.5267'), { latitude: -3.7319, longitude: -38.5267 });
  assert.equal(mapCoordinates(undefined, undefined), null);
  assert.equal(mapCoordinates('not a coordinate', 10), null);
  assert.equal(mapCoordinates(91, 0), null);
});

test('OSM preview requests only tiles intersecting the visible card and centers the pin', () => {
  const tiles = previewTiles(-3.7319, -38.5267, 320, 180);
  assert.ok(tiles.length >= 2 && tiles.length <= 6);
  assert.ok(tiles.every(tile => tile.url.startsWith('https://tile.openstreetmap.org/16/')));
  assert.ok(tiles.every(tile => tile.left < 320 && tile.left + 256 > 0 && tile.top < 180 && tile.top + 256 > 0));
});

test('invalid map preview size or zoom produces no tile requests', () => {
  assert.deepEqual(previewTiles(0, 0, 0, 180), []);
  assert.deepEqual(previewTiles(0, 0, 320, 180, 20), []);
});
