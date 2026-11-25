export type GatewayErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_DENIED'
  | 'INVALID_INPUT'
  | 'AUTH_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'REMOTE_CLI_FORBIDDEN'
  | 'PATH_OUTSIDE_SHARE'
  | 'PROPOSAL_NOT_ACTIVATED'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface AuthHandoffInfo {
  sourceId: string;
  authUrl: string;
  cliCommand?: string;
  reason: string;
  expiresAt: string;
}

export interface ApprovalErrorInfo {
  approvalId: string;
  approvalUrl: string;
  status: 'pending' | 'denied' | 'expired';
  reason: string;
}

export interface GatewayErrorOptions {
  details?: Record<string, unknown>;
  authHandoff?: AuthHandoffInfo;
  approval?: ApprovalErrorInfo;
  cause?: unknown;
}

export function defaultHttpStatusForCode(code: GatewayErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'AUTH_REQUIRED':
      return 401;
    case 'FORBIDDEN':
    case 'CAPABILITY_DENIED':
    case 'APPROVAL_DENIED':
    case 'REMOTE_CLI_FORBIDDEN':
    case 'PATH_OUTSIDE_SHARE':
    case 'PROPOSAL_NOT_ACTIVATED':
      return 403;
    case 'CAPABILITY_NOT_FOUND':
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'INVALID_INPUT':
      return 400;
    case 'APPROVAL_REQUIRED':
      return 202;
    case 'APPROVAL_TIMEOUT':
    case 'UPSTREAM_TIMEOUT':
      return 504;
    case 'UPSTREAM_UNAVAILABLE':
      return 503;
    case 'UPSTREAM_ERROR':
      return 502;
    case 'INTERNAL_ERROR':
    default:
      return 500;
  }
}

export class GatewayError extends Error {
  public readonly code: GatewayErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;
  public readonly authHandoff?: AuthHandoffInfo;
  public readonly approval?: ApprovalErrorInfo;

  constructor(
    code: GatewayErrorCode,
    message: string,
    httpStatusOrOptions?: number | GatewayErrorOptions,
    maybeOptions?: GatewayErrorOptions,
  ) {
    const options =
      typeof httpStatusOrOptions === 'object' ? httpStatusOrOptions : maybeOptions;
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GatewayError';
    this.code = code;
    this.httpStatus =
      typeof httpStatusOrOptions === 'number'
        ? httpStatusOrOptions
        : defaultHttpStatusForCode(code);
    this.details = options?.details;
    this.authHandoff = options?.authHandoff;
    this.approval = options?.approval;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(this.authHandoff !== undefined ? { authHandoff: this.authHandoff } : {}),
        ...(this.approval !== undefined ? { approval: this.approval } : {}),
      },
    };
  }
}
