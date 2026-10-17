export type AuthErrorCode = "AUTH_NOT_CONFIGURED" | "UNAUTHENTICATED" | "FORBIDDEN";

/** An authentication/authorization failure. Messages are safe to show to a user. */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function authErrorResponse(error: AuthError): Response {
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
}
