# E2E Testing

The repository supplies E2E specialist agents, a manual org template, and an opt-in declarative `e2e` DAG. It does not bundle a browser, a running application, credentials, or a universal Playwright configuration.

## Automatic E2E DAG

Enable automatic workflow budgets first, then start:

```text
/workflow-auto e2e Exercise the requested user flow --mode=standard
```

The installed definition declares these dependency-ordered stages:

| Stage | Routed role | Contract |
|---|---|---|
| `setup` | `planning` | Inspect application startup, test tooling, credentials guidance, requested scope, and cleanup needs |
| `e2e_exploration` | `e2e_exploration` | Exercise the requested flow, one adjacent path, and one obvious failure path |
| `e2e_generation` | `e2e_generation` | Create or update focused executable coverage from observed behavior |
| `e2e_validation` | `e2e_validation` | Run tests and check assertions, waits, console errors, responses, and cleanup |
| `quality_gate` | `quality_gate` | Verify passing evidence and repository quality |
| `completion_guard` | `completion_guard` | Confirm the requested outcome is directly supported by execution evidence |

The selected mode maps these roles to installed `wf-*` agents. The automatic engine schedules them as SDK child sessions and requires the same structured stage result contract as other automatic workflows.

## Persistence And Resume

Automatic E2E state is owned by the starting OpenCode session, directory, and worktree. After a plugin restart, no new stage launches until:

```text
/workflow-auto-resume
```

Resume reauthorizes agents and reconciles any saved child sessions before continuing. Token, cost, wall-time, session, parallelism, and attempt budgets apply to E2E stages.

## Browser Evidence

E2E agents are instructed to prefer direct execution evidence and stable user-facing selectors. The requested flow should include:

- The primary path
- One adjacent or alternate path
- One obvious failure path
- Relevant console and page errors
- Unexpected redirects or HTTP failures
- Test-data and browser-process cleanup

The generator should follow the project's existing test conventions. It should not invent credentials, claim a browser run it did not perform, or leave created records behind. If the required browser integration, application, or credentials are unavailable, the stage should return a failed result with the blocker.

## Selectors And Reliability

Prefer semantic Playwright locators such as `getByRole` and `getByLabel`. Use stable test IDs only when the interface has no suitable user-facing locator. Avoid hardcoded sleeps, brittle DOM paths, hidden retries that mask failures, and assertions that merely confirm navigation occurred.

CSS locators are not universally forbidden; they should be used only when the application's existing test conventions and DOM contract make them the most stable choice. The validation stage evaluates the actual test rather than applying a fixed regex policy.

## Manual Template

The installed `templates/e2e-testing.org` remains available to the manual supervisor. Manual templates are agent instructions, not the declarative DAG and not an automatic scheduler. Manual state uses gate sidecars and native Task IDs; automatic E2E state uses stage sessions and budgets.

## Project Verification

Run the commands appropriate to the target repository. Common Playwright commands include:

```bash
npx playwright test
npx playwright test path/to/spec
npx playwright test --headed
```

Do not install or upgrade browser dependencies without reviewing the target project's package-manager and lockfile conventions.

## Related Documentation

- [Automatic DAG Lifecycle](../WORKFLOWS.md#automatic-dag-lifecycle)
- [Agent Reference](./agents.md)
- [Review System](./review-system.md)
