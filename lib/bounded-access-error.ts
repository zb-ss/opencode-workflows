export type BoundedAccessErrorCode =
  | 'credential_content'
  | 'hard_link'
  | 'invalid_utf8'
  | 'missing_file'
  | 'outside_worktree'
  | 'protected_write'
  | 'sensitive_path'
  | 'symlink_path'
  | 'too_large'
  | 'unsupported_read'

export class BoundedAccessError extends Error {
  constructor(
    readonly code: BoundedAccessErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BoundedAccessError'
  }
}
