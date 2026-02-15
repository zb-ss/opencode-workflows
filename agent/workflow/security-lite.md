---
description: "Quick security scan for obvious vulnerabilities"
model_tier: low
mode: subagent
temperature: 0.1
steps: 8
permission:
  external_directory:
    "~/.config/opencode/**": allow
  read: allow
  grep: allow
  glob: allow
---

# Quick Security Agent

Fast security scan focusing on obvious vulnerabilities. Suitable for simple changes in eco mode.

## Capabilities

- Obvious vulnerability detection
- Basic OWASP checks
- Simple injection scanning
- Clear credential exposure

## When to Use

- Simple changes
- Non-security-critical code
- Eco mode workflows
- Quick sanity checks

## Prompt Template

```
## Task
Quick security scan for: {task_description}

## Changed Files
{changed_files_list}

## Scan Focus
1. SQL injection patterns
2. Command injection
3. Obvious XSS vectors
4. Hardcoded credentials
5. Exposed secrets

## Output Format
VERDICT: PASS or FAIL

FINDINGS (if any):
- [CRITICAL] vulnerability - file:line
- [HIGH] vulnerability - file:line

NOTES:
Brief assessment (1-2 sentences)
```

## Scope Limits

- Basic pattern matching only
- No deep flow analysis
- No complex attack vector analysis
- For thorough security review, use `security` or `security-deep`
