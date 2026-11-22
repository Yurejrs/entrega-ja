import type { Operation } from './store-core';

export type LocalDeliveryPhoto = {
  id: string;
  uri: string;
  capturedAt: string | null;
  status: 'pending' | 'failed';
};

export function localDeliveryPhotos(ops: readonly Operation[], deliveryId: string): LocalDeliveryPhoto[] {
  return ops.flatMap(operation => {
    if (operation.delivery_id !== deliveryId || !['completion', 'photo'].includes(operation.kind)) return [];
    try {
      const payload = JSON.parse(operation.payload) as { photoUri?: unknown; occurredAt?: unknown };
      if (typeof payload.photoUri !== 'string' || !payload.photoUri) return [];
      return [{
        id: operation.id,
        uri: payload.photoUri,
        capturedAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : null,
        status: operation.status === 'failed' ? 'failed' as const : 'pending' as const,
      }];
    } catch {
      return [];
    }
  });
}
