---
description: Start an automated development workflow
agent: supervisor
model_tier: mid
---

Start a new automated workflow.

## Usage
```
/workflow <type> <description>
```

## Available Workflow Types
- `feature` - Full feature development (plan → implement → review → test → security → commit)
- `figma` - Figma design to code (plan → implement → review → test → a11y → commit)
- `bug-fix` - Bug investigation and fix (investigate → plan fix → implement → review → test → commit)
- `refactor` - Code refactoring (analyze → plan → implement → review → test → commit)
- `translate` - Joomla component translation (scan → process views one-by-one → review → commit)

## Examples
```
/workflow feature Add user authentication with JWT tokens
/workflow feature Implement shopping cart with checkout flow
/workflow figma https://figma.com/file/xxx/Design?node-id=1:2 Dashboard header component
/workflow translate /path/to/com_mycomponent fr-CA
/workflow translate ./components/com_content fr-CA
```

## Your Task

You are the supervisor agent. A new workflow has been requested:

**Type**: $1
**Description**: $ARGUMENTS

### Instructions

1. **Validate the workflow type**
   - If type is not recognized, list available types and ask for clarification

2. **For `feature` workflows**:
   - Load template from `templates/feature-development.org`
   - The description ($ARGUMENTS minus $1) is the feature request

3. **For `figma` workflows**:
   - Load template from `templates/figma-to-code.org`
   - First argument after type should be Figma URL
   - Remaining arguments are the description

4. **For `translate` workflows**:
   - Load template from `templates/joomla-translation.org`
   - First argument after type is the component path
   - Second argument is the target language code (e.g., fr-CA, es-ES, de-DE)
   - Optional third argument is source language (defaults to en-GB)
   - Uses specialized agents: translation-planner, translation-coder, translation-reviewer
   
   **IMPORTANT: View-by-View Processing**
   Translation workflows process ONE VIEW AT A TIME:
   1. Step 0: Scan component and create view queue
   2. Step 1: User runs `/translate-view next` for EACH view
   3. Step 2: Final review after ALL views complete
   4. Step 3: Commit
   
   This prevents LLM context overflow and ensures thorough processing.

5. **Start the workflow**:
   - Ask user about branch strategy
   - Create workflow state file in `workflows/active/`
   - Begin executing steps according to the template
   - Keep workflow state file updated after each action

6. **Execute steps sequentially**:
   - Use @agent invocations for each step
   - Update workflow org file with progress
   - Send notifications on completions
   - Pause on failures for human intervention

Begin by validating the request and asking about branch strategy.

## Translation Workflow Special Instructions

For `translate` workflows, after Step 0 (component scan) completes:

1. **Inform the user** that views will be processed one at a time
2. **Show the view queue** - list all views to be processed
3. **Instruct user** to run `/translate-view next` to process each view
4. **Track progress** in the view-queue.org file
5. **Do NOT attempt** to process all views in a single session

Example flow:
```
User: /workflow translate /path/to/com_lots fr-CA
Assistant: [Scans component, creates view queue]
           "Found 8 views to process. Run `/translate-view next` to begin."

User: /translate-view next
Assistant: [Processes views/lot/tmpl/edit.php completely]
           "View complete. 187 strings converted. 7 views remaining."

User: /translate-view next
Assistant: [Processes next view]
           ... continues until all views done ...

User: /translate-view next
Assistant: "All views complete! Running final review..."
```
