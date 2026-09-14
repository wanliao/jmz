/** 统一的业务错误：带上 HTTP 状态码和机器可读的错误码，前端据此给出中文提示 */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function badRequest(message, code = 'BAD_REQUEST', details) {
  return new HttpError(400, code, message, details);
}

export function notFound(message, code = 'NOT_FOUND', details) {
  return new HttpError(404, code, message, details);
}

export function normalizeError(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
      },
    };
  }
  const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
  return {
    status,
    body: {
      ok: false,
      error: {
        code: error?.code ?? 'INTERNAL_ERROR',
        message: error?.message ?? '服务器内部错误',
      },
    },
  };
}
