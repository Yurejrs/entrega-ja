import test from 'node:test';
import assert from 'node:assert/strict';
import { isMoreActive, mobileMoreSections, moreMenuState, tenantSections } from '../src/navigation.ts';

test('folha Mais deriva as rotas fora da barra inferior', () => {
  assert.deepEqual(mobileMoreSections(tenantSections).map(section => section.key), [
    'delivery-items', 'addresses', 'users', 'gamification', 'settings',
  ]);
});

test('rota atual fica ativa tanto na folha quanto no botão Mais', () => {
  const more = mobileMoreSections(tenantSections);
  const current = 'users';
  assert.equal(isMoreActive(more, current), true);
  assert.equal(more.find(section => section.key === current)?.label, 'Equipe');
});

test('estado da folha abre e fecha', () => {
  assert.equal(moreMenuState(false, 'open'), true);
  assert.equal(moreMenuState(true, 'close'), false);
});
