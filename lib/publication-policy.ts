import path from 'node:path'

export const PUBLICATION_REQUEST_FILE_ARGUMENT = '{request_file}'
export const PUBLICATION_REQUEST_PROTOCOL = 'opencode-workflows-publication-request-v1'
export const PUBLICATION_ACKNOWLEDGMENT_PROTOCOL = 'opencode-workflows-publication-ack-v1'
export const PUBLICATION_SCAN_POLICY_VERSION = 'publication-scan-v1'
export const PUBLICATION_SCHEMA_VERSION = 1 as const
export const PUBLICATION_PREPARED_PUBLISHER_SCHEMA_VERSION = 1 as const
export const PUBLICATION_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const PUBLICATION_FULL_GIT_REF_PATTERN = /^refs\/[^\u0000-\u0020\u007F~^:?*\[\]\\]+$/
export const PUBLICATION_SOURCE_BRANCH_REF_PATTERN = /^refs\/heads\/[^\u0000-\u0020\u007F~^:?*\[\]\\]+$/
export const MAX_PUBLICATION_PROTOCOL_STRING_LENGTH = 1024
export const MAX_PUBLICATION_REMOTE_URL_LENGTH = 2048
export const MAX_PUBLICATION_ENVIRONMENT_NAMES = 64

const PROHIBITED_PUBLICATION_ENVIRONMENT_NAMES = new Set([
  'BASH_ENV',
  'BASHOPTS',
  'CDPATH',
  'CLASSPATH',
  'ENV',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'HOME',
  'IFS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LUA_CPATH',
  'LUA_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PERL5LIB',
  'PERL5OPT',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'SHELLOPTS',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'TCLLIBPATH',
  'ZDOTDIR',
  '_JAVA_OPTIONS',
])

const PROHIBITED_PUBLICATION_ENVIRONMENT_PREFIXES = ['DYLD_', 'GIT_', 'LD_']

export function isAbsolutePublicationPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

export function isWorktreeRelativePublicationPath(value: string): boolean {
  if (isAbsolutePublicationPath(value)) return false
  return !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)
}

export function isFullPublicationGitRef(value: string): boolean {
  if (value.length < 1 || value.length > MAX_PUBLICATION_PROTOCOL_STRING_LENGTH) return false
  if (!PUBLICATION_FULL_GIT_REF_PATTERN.test(value) || value.endsWith('/') || value.endsWith('.')) return false
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false
  return value.split('/').every(component => component.length > 0
    && !component.startsWith('.')
    && !component.startsWith('-')
    && !component.endsWith('.lock'))
}

export function isPublicationSourceBranchRef(value: string): boolean {
  return PUBLICATION_SOURCE_BRANCH_REF_PATTERN.test(value) && isFullPublicationGitRef(value)
}

export function normalizePublicationRemoteUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PUBLICATION_REMOTE_URL_LENGTH
    || /[\u0000-\u0020\u007F\\]/.test(value)) {
    return null
  }
  try {
    const remote = new URL(value)
    if (!['https:', 'ssh:'].includes(remote.protocol)
      || remote.username || remote.password || remote.search || remote.hash
      || !remote.hostname || remote.pathname.length === 0 || remote.pathname === '/') {
      return null
    }
    remote.protocol = remote.protocol.toLocaleLowerCase('en-US')
    remote.hostname = remote.hostname.toLocaleLowerCase('en-US')
    return remote.toString()
  } catch {
    return null
  }
}

export function isPublicationPublisherArgv(value: unknown): value is readonly [string, string] {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [executable, requestArgument] = value
  return typeof executable === 'string'
    && executable.length > 0
    && executable.length <= MAX_PUBLICATION_PROTOCOL_STRING_LENGTH
    && !executable.includes('\0')
    && !/[{}]/.test(executable)
    && isAbsolutePublicationPath(executable)
    && requestArgument === PUBLICATION_REQUEST_FILE_ARGUMENT
}

export function isPublicationEnvironmentAllowlist(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_PUBLICATION_ENVIRONMENT_NAMES
    && value.every(name => typeof name === 'string'
      && PUBLICATION_ENVIRONMENT_NAME_PATTERN.test(name)
      && !PROHIBITED_PUBLICATION_ENVIRONMENT_NAMES.has(name)
      && !PROHIBITED_PUBLICATION_ENVIRONMENT_PREFIXES.some(prefix => name.startsWith(prefix)))
    && new Set(value).size === value.length
}

export function isPublicationSuccessExitCodes(value: unknown): value is readonly [0] {
  return Array.isArray(value) && value.length === 1 && value[0] === 0
}

export function isOperatorOwnedPublicationExecutable(stat: { uid: bigint; mode: bigint }): boolean {
  return stat.uid === 0n && (stat.mode & 0o022n) === 0n
}
