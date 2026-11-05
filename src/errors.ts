export interface ErrorFields {
  statusCode?: number
  grpcCode?: number
  traceCode?: string
  requestId?: string
  idempotencyKey?: string
  capability?: string
  resourceName?: string
  envelopeName?: string
  retryAfter?: string
  fieldViolations?: FieldViolation[]
}

export interface FieldViolation {
  field: string
  description: string
}

export class SigningflowError extends Error {
  readonly statusCode?: number
  readonly grpcCode?: number
  readonly traceCode?: string
  readonly requestId?: string
  readonly idempotencyKey?: string
  readonly capability?: string
  readonly resourceName?: string
  envelopeName?: string
  readonly retryAfter?: string
  readonly fieldViolations?: FieldViolation[]

  constructor(message: string, fields: ErrorFields = {}) {
    super(message)
    this.name = new.target.name
    this.statusCode = fields.statusCode
    this.grpcCode = fields.grpcCode
    this.traceCode = fields.traceCode
    this.requestId = fields.requestId
    this.idempotencyKey = fields.idempotencyKey
    this.capability = fields.capability
    this.resourceName = fields.resourceName
    this.envelopeName = fields.envelopeName
    this.retryAfter = fields.retryAfter
    this.fieldViolations = fields.fieldViolations
  }
}

export class SigningflowAuthenticationError extends SigningflowError {}
export class SigningflowPermissionError extends SigningflowError {}
export class SigningflowIdempotencyError extends SigningflowError {}
export class SigningflowRateLimitError extends SigningflowError {}
export class SigningflowInvalidRequestError extends SigningflowError {}
export class SigningflowAPIError extends SigningflowError {}
export class SigningflowConnectionError extends SigningflowError {}
export class SigningflowSignatureVerificationError extends SigningflowError {}

export function attachEnvelope(error: unknown, envelopeName: string): never {
  if (error instanceof SigningflowError) error.envelopeName = envelopeName
  throw error
}
