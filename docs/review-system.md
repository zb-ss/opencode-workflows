# Zero-Tolerance Review System

OpenCode Workflows v2.0 implements a strict zero-tolerance review protocol where **any issue of any severity fails the review**.

## Core Principle

**VERDICT: PASS requires ZERO issues**

- One MINOR issue = FAIL
- One MAJOR issue = FAIL
- One CRITICAL issue = FAIL
- Zero issues = PASS

No exceptions. No "acceptable threshold". Zero issues only.

## Issue Tracking Format

All reviewers must report issues using this standardized format:

```
[ISSUE-N] [SEVERITY] Brief description - file:line - suggested fix
```

**Example**:
```
[ISSUE-1] [CRITICAL] SQL injection vulnerability in user query - src/UserService.php:45 - Use prepared statement
[ISSUE-2] [MAJOR] Missing input validation on email field - src/Controllers/AuthController.php:78 - Add email format validation
[ISSUE-3] [MINOR] Inconsistent naming convention (camelCase vs snake_case) - src/Models/User.php:12 - Rename $userId to $user_id
```

### Issue Number (`[ISSUE-N]`)
- Sequential, starting from 1
- Unique per review iteration
- Resets to 1 on re-verification

### Severity Levels

| Level | Definition | Examples |
|-------|------------|----------|
| **CRITICAL** | Security vulnerability, data corruption risk, system crash | SQL injection, XSS, race condition, null pointer |
| **MAJOR** | Incorrect behavior, performance bottleneck, accessibility violation | Missing validation, N+1 query, broken responsive design |
| **MINOR** | Convention violation, style inconsistency, missing documentation | Naming mismatch, TODO comment, unused variable |

### File Location
- Format: `path/to/file.ext:line_number`
- Use relative path from project root
- Line number required (use line where issue starts)

### Suggested Fix
- Actionable remediation step
- Brief (1-2 sentences)
- Specific, not generic advice

## Review Workflow

### Iteration 1: Initial Review

1. **Reviewer** performs comprehensive analysis
2. **Reviewer** reports all issues using [ISSUE-N] format
3. **Reviewer** returns `VERDICT: FAIL` if any issues found
4. **Executor** receives issue list
5. **Executor** fixes all issues OR disputes specific issues
6. Proceed to iteration 2

### Iteration 2+: Re-Verification

1. **Reviewer** re-examines **only** previously flagged files/lines
2. **Reviewer** verifies each [ISSUE-N] is resolved
3. **Reviewer** searches for **new** issues introduced by fixes
4. **Reviewer** reports:
   - Resolved: `[ISSUE-N] RESOLVED`
   - Still present: `[ISSUE-N] STILL PRESENT - additional context`
   - New issues: `[ISSUE-N+X] [SEVERITY] ...` (new numbering)
5. **Verdict**:
   - All resolved, no new issues → `VERDICT: PASS`
   - Any unresolved or new issues → `VERDICT: FAIL`

**Example iteration 2 output**:
```
[ISSUE-1] RESOLVED
[ISSUE-2] STILL PRESENT - validation added but regex is incorrect
[ISSUE-3] RESOLVED
[ISSUE-4] [MINOR] New issue: added validation uses deprecated function - src/Controllers/AuthController.php:82 - Use Validator::email() instead

VERDICT: FAIL (1 unresolved, 1 new issue)
```

### Maximum Iterations

Each reviewer has a maximum iteration limit:

| Reviewer Type | Max Iterations |
|---------------|----------------|
| reviewer-lite | 2 |
| reviewer | 3 |
| reviewer-deep | 5 |

**After max iterations**: Escalate to higher-tier model or mark for manual intervention.

## Auto-Escalation

When max iterations reached without PASS:

1. **Log escalation**: `ESCALATION: reviewer-lite → reviewer (max iterations reached)`
2. **Invoke higher tier**: Switch from lite → standard → deep
3. **Reset iteration counter**: Start at 1 with new reviewer
4. **If highest tier fails**: Return issues to user, pause workflow

**Example escalation chain**:
```
reviewer-lite (2 iterations) → FAIL
  ↓
reviewer (3 iterations) → FAIL
  ↓
reviewer-deep (5 iterations) → PASS or manual intervention
```

## Executor Fix Protocol

When executor receives `VERDICT: FAIL` with issues:

### 1. Acknowledge All Issues
```
Received FAIL verdict with 3 issues:
- [ISSUE-1] CRITICAL - SQL injection
- [ISSUE-2] MAJOR - Missing validation
- [ISSUE-3] MINOR - Naming inconsistency

Proceeding to fix all issues.
```

### 2. Fix Each Issue
- Address issues in severity order (CRITICAL → MAJOR → MINOR)
- Make minimal changes (don't refactor unrelated code)
- Validate fixes (run linters, tests)

### 3. Report Fixes
```
Fixed:
- [ISSUE-1]: Replaced string concatenation with prepared statement
- [ISSUE-2]: Added email validation using Validator::email()
- [ISSUE-3]: Renamed $userId to $user_id per conventions

Re-submitting for review.
```

### 4. Dispute Protocol (Optional)

If executor disagrees with an issue:

```
DISPUTE [ISSUE-2]:
Reason: Email validation already exists in middleware (src/Middleware/ValidateInput.php:23)
Evidence: [code snippet]
Request: Remove from issue list
```

Reviewer must re-examine and either:
- Accept dispute: `[ISSUE-2] DISPUTE ACCEPTED - validation confirmed in middleware`
- Reject dispute: `[ISSUE-2] DISPUTE REJECTED - middleware not invoked for this route`

## Review Gates

Different workflow modes enforce different review gates:

### Eco Mode
- **Gates**: 1 (final review)
- **Reviewer**: reviewer-lite
- **Max iterations**: 2

### Standard Mode
- **Gates**: 2 (implementation review, final review)
- **Reviewer**: reviewer
- **Max iterations**: 3

### Turbo Mode
- **Gates**: 1 (final review)
- **Reviewer**: reviewer
- **Max iterations**: 2

### Thorough Mode
- **Gates**: 3 (implementation, testing, security)
- **Reviewer**: reviewer-deep
- **Max iterations**: 5

### Swarm Mode
- **Gates**: 1 (parallel validation by 3 architects)
- **Reviewers**: 3x architect
- **Consensus**: 2/3 must PASS

## Swarm Mode Consensus

In swarm mode, 3 reviewers analyze in parallel:

1. **All reviewers** submit verdicts simultaneously
2. **Consensus logic**:
   - 3/3 PASS → Final verdict: PASS
   - 2/3 PASS → Final verdict: PASS (majority)
   - 1/3 PASS → Final verdict: FAIL
   - 0/3 PASS → Final verdict: FAIL

3. **Issue aggregation**:
   - Merge all unique issues from FAIL reviews
   - Remove duplicate issues (same file:line)
   - Return combined issue list to executor

**Example**:
```
Reviewer A: PASS
Reviewer B: FAIL (2 issues)
Reviewer C: PASS

Consensus: PASS (2/3)
Note: Reviewer B raised concerns, but majority accepts implementation.
```

## Reviewer Agent Mapping

| Agent | Tier | Scope | Max Iterations |
|-------|------|-------|----------------|
| reviewer-lite | low | Code quality, basic security | 2 |
| reviewer | mid | Full review against plan | 3 |
| reviewer-deep | high | Architecture, performance, security | 5 |
| security-lite | low | OWASP Top 10 basics | 2 |
| security | mid | Comprehensive security audit | 3 |
| security-deep | high | Advanced threats, cryptography | 5 |
| perf-lite | low | Obvious performance issues | 2 |
| perf-reviewer | high | Profiling, optimization analysis | 5 |

## Best Practices

### For Reviewers
1. **Be thorough on iteration 1** - find all issues upfront
2. **Use precise file:line references** - executor must know exactly where
3. **Suggest actionable fixes** - not just "fix this"
4. **Don't nitpick on iteration 2+** - focus on resolution of existing issues
5. **Document new issues clearly** - use NEW numbering

### For Executors
1. **Fix all issues before re-submitting** - don't skip MINOR issues
2. **Run validation after fixes** - linters, tests, syntax checks
3. **Dispute respectfully** - provide evidence, not opinions
4. **Don't introduce new issues** - minimal changes only
5. **Track iteration count** - escalate proactively if stuck

### For Workflow Designers
1. **Match reviewer to criticality** - use deep reviewer for security-critical code
2. **Set realistic iteration limits** - 3 is standard, 5 for complex tasks
3. **Define clear escalation paths** - lite → standard → deep
4. **Balance speed vs quality** - eco mode for prototypes, thorough for production

## Example: Complete Review Cycle

### Iteration 1
**Reviewer output**:
```
VERDICT: FAIL

Issues found:
[ISSUE-1] [CRITICAL] Hardcoded API key in source - src/config.php:12 - Move to .env
[ISSUE-2] [MAJOR] No error handling on HTTP request - src/ApiClient.php:34 - Add try/catch
[ISSUE-3] [MINOR] Unused import statement - src/Services/UserService.php:5 - Remove unused use statement
```

**Executor fixes and responds**:
```
All issues fixed:
- [ISSUE-1]: Moved API key to .env, load via $_ENV
- [ISSUE-2]: Added try/catch with proper error logging
- [ISSUE-3]: Removed unused import

Re-submitting for iteration 2.
```

### Iteration 2
**Reviewer output**:
```
[ISSUE-1] RESOLVED - API key now loaded from environment
[ISSUE-2] RESOLVED - proper exception handling added
[ISSUE-3] RESOLVED - import removed
[ISSUE-4] [MINOR] .env.example not updated with new API_KEY variable - .env.example:1 - Add API_KEY entry

VERDICT: FAIL (1 new issue)
```

**Executor fixes**:
```
Fixed new issue:
- [ISSUE-4]: Added API_KEY to .env.example

Re-submitting for iteration 3.
```

### Iteration 3
**Reviewer output**:
```
[ISSUE-4] RESOLVED

VERDICT: PASS

All issues resolved. Code meets quality standards.
```

## Configuration

Review iterations and escalation are configured per-mode in `mode/*.json`:

```json
{
  "settings": {
    "max_review_iterations": 3,
    "max_security_iterations": 2,
    "escalation": {
      "review_after": 2,
      "review_escalate_to": "reviewer-deep",
      "security_after": 1,
      "security_escalate_to": "security-deep"
    }
  }
}
```

See `mode/standard.json`, `mode/thorough.json`, etc. for mode-specific defaults.
