# E2E Testing Pipeline with Playwright

OpenCode Workflows v2.0 includes a comprehensive 6-phase E2E testing workflow powered by Playwright.

## Overview

The E2E testing pipeline automatically:
1. Explores your application structure
2. Generates accessibility-first test suites
3. Validates tests for flakiness
4. Runs quality gate checks
5. Reports results

**Technology**: Playwright with TypeScript

## 6-Phase Workflow

### Phase 1: Setup

**Agent**: executor-lite

**Tasks**:
- Install Playwright if not present
- Create test directory structure
- Generate playwright.config.ts
- Set up test fixtures

**Output**: Configured test environment

### Phase 2: Exploration

**Agent**: e2e-explorer

**Tasks**:
- Crawl application using BFS traversal
- Identify pages, routes, forms, interactive elements
- Map application structure
- Generate app-map.json

**BFS Traversal**:
```typescript
// Start from root URL
const queue = [{ url: '/', depth: 0 }]
const visited = new Set()

while (queue.length > 0) {
  const { url, depth } = queue.shift()
  
  if (visited.has(url) || depth > maxDepth) continue
  
  visited.add(url)
  await page.goto(url)
  
  // Extract interactive elements
  const elements = await extractElements(page)
  
  // Find linked pages
  const links = await page.$$eval('a', links => 
    links.map(l => l.href)
  )
  
  // Add to queue
  queue.push(...links.map(l => ({ url: l, depth: depth + 1 })))
}
```

**app-map.json Example**:
```json
{
  "pages": [
    {
      "url": "/login",
      "forms": [{ "id": "login-form", "inputs": ["email", "password"] }],
      "buttons": [{ "role": "button", "text": "Sign In" }],
      "links": ["/forgot-password", "/register"]
    },
    {
      "url": "/dashboard",
      "auth": "required",
      "interactive": [...]
    }
  ]
}
```

### Phase 3: Test Generation

**Agent**: e2e-generator

**Tasks**:
- Read app-map.json
- Generate test files for each page/feature
- Use accessibility-first selectors
- Create test scenarios (happy path, error cases)

**Selector Priority** (strictly enforced):
1. `getByRole()` - ARIA roles (button, link, heading, etc.)
2. `getByLabel()` - Form labels
3. `getByPlaceholder()` - Input placeholders
4. `getByText()` - Visible text content
5. `getByTestId()` - data-testid attributes

**CSS selectors and XPath are FORBIDDEN**

**Example Generated Test**:
```typescript
import { test, expect } from '@playwright/test'

test.describe('Login Page', () => {
  test('successful login redirects to dashboard', async ({ page }) => {
    await page.goto('/login')
    
    // Use getByLabel (priority 2)
    await page.getByLabel('Email').fill('user@example.com')
    await page.getByLabel('Password').fill('password123')
    
    // Use getByRole (priority 1)
    await page.getByRole('button', { name: 'Sign In' }).click()
    
    // Assertion
    await expect(page).toHaveURL('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })
  
  test('invalid credentials show error', async ({ page }) => {
    await page.goto('/login')
    
    await page.getByLabel('Email').fill('invalid@example.com')
    await page.getByLabel('Password').fill('wrong')
    await page.getByRole('button', { name: 'Sign In' }).click()
    
    // Error message should be visible
    await expect(page.getByText('Invalid credentials')).toBeVisible()
  })
})
```

### Phase 4: Validation

**Agent**: e2e-reviewer

**Tasks**:
- Run each test 3 times to detect flakiness
- Check for anti-patterns
- Verify accessibility selector usage
- Report issues using [ISSUE-N] format

**Flakiness Detection**:
```typescript
// Run test 3 times
const results = []
for (let i = 0; i < 3; i++) {
  const result = await runTest(testFile)
  results.push(result.status)
}

// Analyze consistency
const passed = results.filter(r => r === 'passed').length
if (passed < 3) {
  report('[ISSUE-N] [MAJOR] Flaky test detected - passes ' + passed + '/3 times')
}
```

**Anti-Pattern Detection**:

| Anti-Pattern | Severity | Detection |
|--------------|----------|-----------|
| CSS selector usage | CRITICAL | Regex: `page\.locator\(['"][\.\#]` |
| XPath selector | CRITICAL | Regex: `page\.locator\(['"]\/\/` |
| Hardcoded waits | MAJOR | `page.waitForTimeout()` without reason |
| Missing assertions | MAJOR | Test with no `expect()` calls |
| Brittle text matching | MINOR | `getByText()` with exact long strings |

**Example Reviewer Output**:
```
VERDICT: FAIL

[ISSUE-1] [CRITICAL] CSS selector used - tests/login.spec.ts:12 - Replace page.locator('.login-button') with getByRole('button', { name: 'Sign In' })
[ISSUE-2] [MAJOR] Flaky test - tests/dashboard.spec.ts:25 - Test passes 2/3 times, add proper wait condition
[ISSUE-3] [MINOR] Hardcoded wait without reason - tests/checkout.spec.ts:45 - Replace waitForTimeout(2000) with waitForResponse()
```

### Phase 5: Quality Gate

**Agent**: quality-gate

**Tasks**:
- Run full test suite
- Check code coverage (if configured)
- Verify all tests pass
- Validate no skipped/disabled tests
- Final PASS/FAIL verdict

**Quality Gate Criteria**:
- [ ] All tests pass (0 failures)
- [ ] 0 flaky tests detected
- [ ] 0 critical anti-patterns
- [ ] Coverage >= threshold (optional)
- [ ] 0 skipped tests (unless explicitly allowed)

### Phase 6: Completion

**Agent**: supervisor

**Tasks**:
- Generate test report
- Archive workflow state
- Create commit (if requested)
- Send completion notification

## Selector Priority Enforcement

The e2e-generator MUST follow this strict hierarchy:

### Priority 1: getByRole()
Use for any element with an ARIA role:
```typescript
// Buttons
page.getByRole('button', { name: 'Submit' })

// Links
page.getByRole('link', { name: 'Home' })

// Headings
page.getByRole('heading', { name: 'Welcome' })

// Form inputs
page.getByRole('textbox', { name: 'Email' })
page.getByRole('checkbox', { name: 'Remember me' })
```

### Priority 2: getByLabel()
Use for form inputs with associated labels:
```typescript
page.getByLabel('Email address')
page.getByLabel('Password')
page.getByLabel('Date of birth')
```

### Priority 3: getByPlaceholder()
Use when label is unavailable:
```typescript
page.getByPlaceholder('Enter your email')
page.getByPlaceholder('Search...')
```

### Priority 4: getByText()
Use for unique text content:
```typescript
page.getByText('Logout')
page.getByText('Copyright 2025')
```

### Priority 5: getByTestId()
Use as last resort when semantic selectors are impossible:
```typescript
page.getByTestId('user-menu-toggle')
page.getByTestId('notification-badge')
```

### FORBIDDEN: CSS Selectors
```typescript
❌ page.locator('.btn-primary')
❌ page.locator('#login-form')
❌ page.locator('div.container > button')
```

### FORBIDDEN: XPath
```typescript
❌ page.locator('//button[@class="submit"]')
❌ page.locator('//div[contains(@class, "error")]')
```

**Why?**
- CSS/XPath are brittle (break when styling changes)
- Not accessibility-friendly
- Hard to read and maintain
- Don't reflect user interaction patterns

## Configuration

Configure E2E testing in `opencode.jsonc`:

```jsonc
{
  "workflows": {
    "e2e": {
      "template": "e2e-testing",
      "browser": "chromium",
      "headless": true,
      "max_depth": 5,
      "flakiness_runs": 3,
      "quality_gate": {
        "require_all_pass": true,
        "allow_skipped": false,
        "coverage_threshold": 80
      }
    }
  }
}
```

## Running E2E Workflow

### Start E2E Workflow
```bash
/workflow e2e http://localhost:3000 "Test user authentication flow"
```

### Manual Test Execution
```bash
# Run all tests
npx playwright test

# Run specific test file
npx playwright test tests/login.spec.ts

# Run in headed mode
npx playwright test --headed

# Run with UI
npx playwright test --ui
```

## Example: Complete E2E Session

### Input
```bash
/workflow e2e http://localhost:8080 "E2E tests for e-commerce checkout"
```

### Phase 1: Setup
```
✓ Playwright installed (v1.40.0)
✓ Created tests/ directory
✓ Generated playwright.config.ts
✓ Created fixtures
```

### Phase 2: Exploration
```
Exploring http://localhost:8080...
├── / (home)
├── /products (product list)
├── /products/123 (product detail)
├── /cart (shopping cart)
└── /checkout (checkout form)

Generated app-map.json (5 pages, 12 forms, 45 interactive elements)
```

### Phase 3: Generation
```
Generating tests...
✓ tests/home.spec.ts (3 tests)
✓ tests/products.spec.ts (5 tests)
✓ tests/product-detail.spec.ts (4 tests)
✓ tests/cart.spec.ts (6 tests)
✓ tests/checkout.spec.ts (8 tests)

Total: 26 tests generated
```

### Phase 4: Validation
```
Running flakiness check (3x per test)...
✓ tests/home.spec.ts - 3/3 tests stable
✓ tests/products.spec.ts - 5/5 tests stable
✗ tests/cart.spec.ts - 1 flaky test detected
  [ISSUE-1] [MAJOR] "remove item from cart" passes 2/3 times

Checking for anti-patterns...
✗ [ISSUE-2] [CRITICAL] CSS selector in tests/checkout.spec.ts:34

VERDICT: FAIL (2 issues)
```

### Phase 4 (Iteration 2 - After Fixes)
```
Re-validating fixed tests...
✓ [ISSUE-1] RESOLVED - added proper wait condition
✓ [ISSUE-2] RESOLVED - replaced with getByRole()

Running full suite...
✓ 26/26 tests passed

VERDICT: PASS
```

### Phase 5: Quality Gate
```
Running quality gate checks...
✓ All tests pass (26/26)
✓ No flaky tests detected
✓ No anti-patterns found
✓ Coverage: 87% (threshold: 80%)
✓ No skipped tests

VERDICT: PASS
```

### Phase 6: Completion
```
E2E testing workflow complete!

Generated files:
- tests/ (26 test files)
- playwright.config.ts
- app-map.json

Test results:
- Total: 26
- Passed: 26
- Failed: 0
- Flaky: 0

Ready for commit? [y/N]
```

## Best Practices

### 1. Start with Critical Paths
Focus E2E tests on critical user flows:
- Authentication
- Checkout/payment
- Data submission
- Core features

### 2. Keep Tests Independent
Each test should be able to run in isolation:
```typescript
test.beforeEach(async ({ page }) => {
  // Reset state for each test
  await setupTestUser()
  await clearCart()
})
```

### 3. Use Page Object Model
For complex apps, use POM pattern:
```typescript
// pages/login.page.ts
export class LoginPage {
  constructor(private page: Page) {}
  
  async login(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Sign In' }).click()
  }
}

// tests/login.spec.ts
test('login flow', async ({ page }) => {
  const loginPage = new LoginPage(page)
  await loginPage.login('user@test.com', 'pass')
})
```

### 4. Add data-testid for Dynamic Content
When semantic selectors are insufficient:
```html
<div data-testid="user-avatar">...</div>
```

```typescript
await page.getByTestId('user-avatar').click()
```

### 5. Avoid Hardcoded Waits
```typescript
❌ await page.waitForTimeout(2000) // Brittle

✓ await page.waitForResponse(resp => resp.url().includes('/api/users'))
✓ await page.waitForLoadState('networkidle')
```

## Troubleshooting

### Flaky Tests
**Symptom**: Test passes sometimes, fails sometimes

**Solutions**:
- Add explicit waits for API responses
- Use `waitForLoadState()` for page loads
- Check for race conditions
- Increase timeout for slow operations

### Selector Not Found
**Symptom**: `Error: Locator not found`

**Solutions**:
- Verify element is visible: `await expect(element).toBeVisible()`
- Wait for element: `await page.waitForSelector()`
- Check ARIA roles: Use browser DevTools
- Add data-testid if necessary

### Tests Pass Locally, Fail in CI
**Symptom**: All tests pass on dev machine, fail in CI

**Solutions**:
- Use headless mode locally: `npx playwright test --headed=false`
- Check viewport size consistency
- Verify test data availability in CI
- Add retries: `{ retries: 2 }` in config

## See Also

- [Playwright Documentation](https://playwright.dev)
- [Accessibility Testing Guide](https://playwright.dev/docs/accessibility-testing)
- [docs/review-system.md](./review-system.md) - Issue reporting format
