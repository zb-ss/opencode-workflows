---
description: Create a detailed development plan saved as an org file
agent: org-planner
model: anthropic/claude-haiku-4-5
---

Create a comprehensive development plan for: $ARGUMENTS

Analyze the request and create a structured plan that includes:

1. A clear overview of the task/feature/change
2. Hierarchical breakdown of all required tasks
3. Dependencies between tasks
4. Time estimates and priorities
5. Testing considerations
6. Documentation needs
7. Acceptance criteria

Save the plan as an org file in plans/ with:
- Today's date as prefix (YYYY-MM-DD)
- Descriptive kebab-case filename
- Full org-mode formatting with TODO states, priorities, tags
- Proper metadata headers

Make the plan detailed enough that an engineer can follow it step-by-step to complete the work.
