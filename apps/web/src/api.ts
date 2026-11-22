export type Identity = {
  userId: string;
  email: string;
  fullName: string;
  role: 'admin' | 'courier' | 'platform';
  scope: 'tenant' | 'platform';
  tenant: { id: string; name: string } | null;
};

export type ApiError = Error & { status?: number; code?: string };

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;
export let latestDashboardData: unknown = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw Object.assign(new Error('Não foi possível conectar à API. Verifique a rede e tente novamente.'), { status: 0 }) as ApiError;
  }
}

async function responseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as { message?: string; code?: string };
  const error = Object.assign(new Error(body.message ?? `Erro ${response.status}`), {
    status: response.status,
    code: body.code,
  }) as ApiError;
  if (response.status === 401) unauthorizedHandler?.();
  return error;
}

export async function csrf(): Promise<void> {
  const response = await send('/v1/auth/csrf', { credentials: 'include' });
  if (!response.ok) throw await responseError(response);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !csrfToken) await csrf();
  const response = await send('/v1' + path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
  });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as T;
  if (path.startsWith('/tenant/dashboard') && typeof window !== 'undefined') {
    latestDashboardData = body;
    window.dispatchEvent(new CustomEvent('entregaja:dashboard-data', { detail: body }));
  }
  return body;
}

export async function login(email: string, password: string, scope: 'tenant' | 'platform') {
  const response = await send('/v1/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, scope, client: 'web' }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Falha no login');
  csrfToken = body.csrfToken;
  return body;
}

export function clearCsrf(): void {
  csrfToken = null;
}
