export type HttpError = Error & { status?: number; code?: string };

export async function executeRequest<T>(
  url: string,
  token: string | null,
  options: RequestInit = {},
  timeoutMs = options.body instanceof FormData ? 45_000 : 15_000,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('REQUEST_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    const operation = async () => {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
      const body = await response.json().catch(error => {
        if (controller.signal.aborted) throw error;
        return {};
      }) as { message?: string; code?: string };
      if (!response.ok) {
        throw Object.assign(new Error(body.message ?? `Erro ${response.status}`), {
          status: response.status,
          code: body.code,
        }) as HttpError;
      }
      return body as T;
    };
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw Object.assign(new Error(controller.signal.aborted
      ? 'A API demorou para responder. A operação permanece salva para nova tentativa.'
      : 'Sem conexão com a API. Verifique a rede e tente sincronizar novamente.'), {
      status: 0,
      code: 'NETWORK_ERROR',
    }) as HttpError;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
