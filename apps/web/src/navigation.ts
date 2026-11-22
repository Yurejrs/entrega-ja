export type Section = { label: string; path: string; key: string };

export const tenantSections: Section[] = [
  { label: 'Visão geral', path: '/tenant/dashboard', key: 'dashboard' },
  { label: 'Entregas', path: '/deliveries', key: 'deliveries' },
  { label: 'Volumes', path: '/tenant/delivery-items', key: 'delivery-items' },
  { label: 'Clientes', path: '/tenant/customers', key: 'customers' },
  { label: 'Endereços', path: '/tenant/addresses', key: 'addresses' },
  { label: 'Equipe', path: '/tenant/users', key: 'users' },
  { label: 'Gamificação', path: '/tenant/gamification', key: 'gamification' },
  { label: 'Configurações', path: '/tenant/settings', key: 'settings' },
];

export const platformSections: Section[] = [
  { label: 'Empresas', path: '/platform/tenants', key: 'tenants' },
  { label: 'Planos', path: '/platform/plans', key: 'plans' },
  { label: 'Assinaturas', path: '/platform/subscriptions', key: 'subscriptions' },
  { label: 'Uso', path: '/platform/usage', key: 'usage' },
];

export const mobilePrimaryKeys = ['dashboard', 'deliveries', 'customers'] as const;

export function mobileMoreSections(sections: Section[]): Section[] {
  return sections.filter(section => !mobilePrimaryKeys.includes(section.key as typeof mobilePrimaryKeys[number]));
}

export function isMoreActive(sections: Section[], currentKey: string): boolean {
  return sections.some(section => section.key === currentKey);
}

export function moreMenuState(open: boolean, action: 'open' | 'close'): boolean {
  return action === 'open' ? true : action === 'close' ? false : open;
}
