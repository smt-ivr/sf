// Responses and errors. Success bodies are the resource itself; errors are always
// { error: { code, message, fields? } } with a matching HTTP status.

export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message, fields) => new HttpError(400, 'BAD_REQUEST', message, fields);
export const invalid = (fields, message = 'יש שדות שגויים') => new HttpError(422, 'VALIDATION', message, fields);
export const unauthorized = (message = 'נדרשת התחברות') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'אין לך הרשאה לפעולה זו') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'לא נמצא') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, code = 'CONFLICT') => new HttpError(409, code, message);
export const tooMany = (message, retryAfter) => {
  const e = new HttpError(429, 'TOO_MANY_ATTEMPTS', message);
  e.retryAfter = retryAfter;
  return e;
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export const noContent = () => new Response(null, { status: 204 });

export function errorResponse(err) {
  const body = { error: { code: err.code, message: err.message } };
  if (err.fields) body.error.fields = err.fields;
  const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
  return json(body, err.status, headers);
}

export async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    throw badRequest('גוף הבקשה חייב להיות JSON');
  }
  try {
    const body = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw badRequest('JSON לא תקין');
  }
}
