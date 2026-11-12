export type ErrorCode =
  | 'not_configured'
  | 'config_invalid'
  | 'unauthorized'
  | 'payload_too_large'
  | 'invalid_json'
  | 'validation_failed'
  | 'not_found'
  | 'rate_limited'
  | 'internal';

export function errorBody(code: ErrorCode, message: string): { error: ErrorCode; message: string } {
  return { error: code, message };
}

export function errorResponse(
  status: 400 | 401 | 404 | 429 | 500 | 503,
  code: ErrorCode,
  message: string,
): Response {
  return Response.json(errorBody(code, message), { status });
}
