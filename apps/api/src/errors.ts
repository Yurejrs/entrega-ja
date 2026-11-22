export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export function badRequest(message: string): never { throw new ApiError(400, 'BAD_REQUEST', message); }
export function unauthorized(): never { throw new ApiError(401, 'UNAUTHORIZED', 'Autenticação necessária'); }
export function forbidden(): never { throw new ApiError(403, 'FORBIDDEN', 'Acesso negado'); }
export function notFound(): never { throw new ApiError(404, 'NOT_FOUND', 'Recurso não encontrado'); }
export function conflict(message: string): never { throw new ApiError(409, 'CONFLICT', message); }
