export type QueuedRoutePoint = { id: string; payload: string };

export async function retryAsync<T>(operation: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function drainRoutePoints(
  read: () => QueuedRoutePoint[],
  send: (points: QueuedRoutePoint[]) => Promise<Set<string>>,
  remove: (ids: string[]) => void,
  batchSize = 100,
): Promise<number> {
  let sent = 0;
  while (true) {
    const batch = read().slice(0, batchSize);
    if (!batch.length) return sent;
    const confirmed = await send(batch);
    if (!confirmed.size) throw new Error('Nenhum ponto GPS foi confirmado pelo servidor');
    const ids = batch.map(point => point.id).filter(id => confirmed.has(id));
    remove(ids);
    sent += ids.length;
    if (ids.length !== batch.length) throw new Error('O servidor não confirmou todos os pontos GPS');
  }
}
