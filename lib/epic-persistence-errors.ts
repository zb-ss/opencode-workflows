export type EpicStoreErrorCode =
  | 'missing'
  | 'incomplete'
  | 'corrupt'
  | 'unsupported_version'
  | 'unsafe'
  | 'unavailable'
  | 'input'
  | 'transition'
  | 'stale_revision'
  | 'recovery_required'
  | 'bounds_exceeded'

export class EpicStoreError extends Error {
  constructor(readonly code: EpicStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EpicStoreError'
  }
}

export class EpicMissingError extends EpicStoreError {
  constructor(message = 'epic state is missing') {
    super('missing', message)
    this.name = 'EpicMissingError'
  }
}

export class EpicIncompleteStateError extends EpicStoreError {
  constructor(message = 'epic initialization or record settlement is incomplete') {
    super('incomplete', message)
    this.name = 'EpicIncompleteStateError'
  }
}

export class EpicCorruptError extends EpicStoreError {
  constructor(message: string) {
    super('corrupt', message)
    this.name = 'EpicCorruptError'
  }
}

export class EpicUnsupportedVersionError extends EpicStoreError {
  constructor(message: string) {
    super('unsupported_version', message)
    this.name = 'EpicUnsupportedVersionError'
  }
}

export class EpicUnsafeStorageError extends EpicStoreError {
  constructor(message: string) {
    super('unsafe', message)
    this.name = 'EpicUnsafeStorageError'
  }
}

export class EpicUnavailableError extends EpicStoreError {
  constructor(message: string, cause?: unknown) {
    super('unavailable', message, { cause })
    this.name = 'EpicUnavailableError'
  }
}

export class EpicInputError extends EpicStoreError {
  constructor(message: string) {
    super('input', message)
    this.name = 'EpicInputError'
  }
}

export class EpicTransitionError extends EpicStoreError {
  constructor(message: string) {
    super('transition', message)
    this.name = 'EpicTransitionError'
  }
}

export class EpicStaleRevisionError extends EpicStoreError {
  constructor(message: string) {
    super('stale_revision', message)
    this.name = 'EpicStaleRevisionError'
  }
}

export class EpicRecoveryRequiredError extends EpicStoreError {
  constructor(message: string) {
    super('recovery_required', message)
    this.name = 'EpicRecoveryRequiredError'
  }
}

export class EpicBoundsExceededError extends EpicStoreError {
  constructor(message: string) {
    super('bounds_exceeded', message)
    this.name = 'EpicBoundsExceededError'
  }
}
