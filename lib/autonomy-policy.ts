import { boundedPermissionTargets } from './bounded-tool-policy.ts'

export type PermissionAction = 'allow' | 'ask' | 'deny'
export type AutonomyProfile = 'interactive' | 'bounded'

export interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

const HARD_DENIES: readonly PermissionRule[] = [
  { permission: 'workflow_bounded_read', pattern: '.env*', action: 'deny' },
  { permission: 'workflow_bounded_read', pattern: '**/.env*', action: 'deny' },
  { permission: 'external_directory', pattern: '*', action: 'deny' },
  { permission: 'question', pattern: '*', action: 'deny' },
  { permission: 'doom_loop', pattern: '*', action: 'deny' },
  { permission: 'plan_enter', pattern: '*', action: 'deny' },
  { permission: 'plan_exit', pattern: '*', action: 'deny' },
  { permission: 'task', pattern: '*', action: 'deny' },
  { permission: 'delegation_unsafe', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: '*', action: 'deny' },
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'glob', pattern: '*', action: 'deny' },
  { permission: 'grep', pattern: '*', action: 'deny' },
  { permission: 'list', pattern: '*', action: 'deny' },
  { permission: 'lsp', pattern: '*', action: 'deny' },
  { permission: 'read', pattern: '*', action: 'deny' },
  { permission: 'skill', pattern: '*', action: 'deny' },
  { permission: 'webfetch', pattern: '*', action: 'deny' },
  { permission: 'websearch', pattern: '*', action: 'deny' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function permissionName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} has an invalid permission`)
  return value
}

function permissionPattern(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} has an invalid pattern`)
  return value
}

function parseRuleArray(value: unknown[]): PermissionRule[] {
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`permission rule ${index} must be an object`)
    const unexpected = Object.keys(candidate).filter((key) => !['permission', 'pattern', 'action'].includes(key))
    if (unexpected.length > 0) {
      throw new Error(`permission rule ${index} has unsupported properties: ${unexpected.join(', ')}`)
    }
    const { permission, pattern, action } = candidate
    const validPermission = permissionName(permission, `permission rule ${index}`)
    const validPattern = permissionPattern(pattern, `permission rule ${index}`)
    if (!isPermissionAction(action)) {
      throw new Error(`permission rule ${index} has an invalid action`)
    }
    return { permission: validPermission, pattern: validPattern, action }
  })
}

function parseRuleObject(value: Record<string, unknown>): PermissionRule[] {
  const rules: PermissionRule[] = []
  for (const [permission, setting] of Object.entries(value)) {
    permissionName(permission, `permission ${permission || '<empty>'}`)
    if (isPermissionAction(setting)) {
      rules.push({ permission, pattern: '*', action: setting })
      continue
    }
    if (!isRecord(setting)) throw new Error(`permission ${permission} has an invalid rule set`)
    for (const [pattern, action] of Object.entries(setting)) {
      permissionPattern(pattern, `permission ${permission}`)
      if (!isPermissionAction(action)) {
        throw new Error(`permission ${permission} pattern ${pattern} has an invalid action`)
      }
      rules.push({ permission, pattern, action })
    }
  }
  return rules
}

export function parsePermissionRules(value: unknown): PermissionRule[] {
  const rules = Array.isArray(value)
    ? parseRuleArray(value)
    : isRecord(value) ? parseRuleObject(value) : null
  if (!rules) throw new Error('permission rules must be an array or object')
  if (rules.length === 0) throw new Error('permission rules must not be empty')
  return rules
}

function isEnvironmentRead(rule: PermissionRule): boolean {
  return rule.permission === 'read' && /(^|[/\\])\.env(?:$|[.*{]|\[)/.test(rule.pattern)
}

function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  const normalizedPattern = pattern.replaceAll('\\', '/')
  // OpenCode treats a trailing " *" as an optional argument suffix.
  const optionalArguments = normalizedPattern.endsWith(' *')
  const patternBody = optionalArguments ? normalizedPattern.slice(0, -2) : normalizedPattern
  const escaped = patternBody
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const expression = optionalArguments ? `${escaped}(?: .*)?` : escaped
  return new RegExp(`^${expression}$`, process.platform === 'win32' ? 'si' : 's').test(normalized)
}

export function evaluatePermissionRules(rules: readonly PermissionRule[], permission: string, pattern: string): PermissionAction {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) return rule.action
  }
  return 'ask'
}

export function resolveBoundedPermissionRules(value: unknown): PermissionRule[] {
  const converted = parsePermissionRules(value).flatMap((rule): PermissionRule[] => {
    const targets = boundedPermissionTargets(rule.permission)
    if (rule.permission === '*' && rule.action === 'allow') return []
    if (targets.length === 0) return []
    return targets.map((permission) => ({
      permission,
      pattern: rule.pattern,
      action: rule.action === 'allow' && !isEnvironmentRead(rule) ? 'allow' : 'deny',
    }))
  })
  const allows = converted.filter((rule) => rule.action === 'allow')
  const denies = converted.filter((rule) => rule.action !== 'allow')
  return [
    { permission: '*', pattern: '*', action: 'deny' },
    ...allows,
    ...denies,
    ...HARD_DENIES.map((rule) => ({ ...rule })),
  ]
}
