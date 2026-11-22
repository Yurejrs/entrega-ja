import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleRouteSelection } from '../src/route-selection';

test('route stops follow tap order and can be removed without reordering the rest', () => {
  const first='delivery-a';
  const second='delivery-b';
  const third='delivery-c';
  const selection=toggleRouteSelection(toggleRouteSelection(toggleRouteSelection([],first),second),third);

  assert.deepEqual(selection,[first,second,third]);
  assert.deepEqual(toggleRouteSelection(selection,second),[first,third]);
  assert.deepEqual(selection,[first,second,third],'selection updates do not mutate earlier state');
});

test('tapping the same delivery toggles it out of the route', () => {
  assert.deepEqual(toggleRouteSelection(['delivery-a','delivery-b'],'delivery-a'),['delivery-b']);
});
