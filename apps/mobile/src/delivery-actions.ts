export type DeliveryAction = 'check_in' | 'problem' | 'completion' | 'photo' | 'note';

export function availableDeliveryActions(status: string, pendingKinds: DeliveryAction[]) {
  const active = status === 'assigned' || status === 'in_progress' || status === 'problem';
  const blocked = pendingKinds.includes('problem') || pendingKinds.includes('completion');
  return {
    checkIn: active && !blocked,
    problem: active && !blocked,
    completion: (status === 'in_progress' || status === 'problem' || (active && pendingKinds.includes('check_in'))) && !blocked,
  };
}
