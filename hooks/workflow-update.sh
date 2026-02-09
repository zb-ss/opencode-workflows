#!/bin/bash
# Workflow state persistence hook
# Called by PostToolUse hook after Task tool completions
# Updates the org file with step results

set -e

# Resolve repo root portably (works through symlinks)
resolve_repo_root() {
    local source="${BASH_SOURCE[0]}"
    while [ -L "$source" ]; do
        local dir="$(cd -P "$(dirname "$source")" && pwd)"
        source="$(readlink "$source")"
        [[ "$source" != /* ]] && source="$dir/$source"
    done
    echo "$(cd -P "$(dirname "$source")/.." && pwd)"
}
REPO_ROOT="$(resolve_repo_root)"

# Read hook input from stdin
INPUT=$(cat)

# Extract tool information
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_RESULT=$(echo "$INPUT" | jq -r '.tool_result // empty')

# Only process Task tool completions
if [[ "$TOOL_NAME" != "Task" ]]; then
    exit 0
fi

# Find active workflow
WORKFLOW_DIR="$REPO_ROOT/workflows/active"
ACTIVE_WORKFLOW=$(ls -t "$WORKFLOW_DIR"/*.org 2>/dev/null | head -1)

if [[ -z "$ACTIVE_WORKFLOW" || ! -f "$ACTIVE_WORKFLOW" ]]; then
    exit 0
fi

# Get current timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Extract subagent type from the input if available
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')

# Determine which step was just completed based on agent type
case "$SUBAGENT_TYPE" in
    "Plan"|"org-planner")
        STEP="Step 0: Planning"
        ;;
    "focused-build"|"editor")
        STEP="Step 1: Implementation"
        ;;
    "review")
        STEP="Step 2: Code Review"
        ;;
    "security-auditor")
        STEP="Step 3: Security Audit"
        ;;
    "test-writer")
        STEP="Step 4: Test Writing"
        ;;
    *)
        STEP=""
        ;;
esac

if [[ -n "$STEP" ]]; then
    # Update the org file - mark step with completion timestamp
    # Using sed to update COMPLETED_AT property for the step

    # Create a Python script for more reliable org file updates
    python3 << PYTHON_EOF
import re
import sys
from datetime import datetime

workflow_file = "$ACTIVE_WORKFLOW"
step_name = "$STEP"
timestamp = "$TIMESTAMP"

try:
    with open(workflow_file, 'r') as f:
        content = f.read()

    # Update UPDATED_AT in Overview
    content = re.sub(
        r'(:UPDATED_AT:)\s*.*',
        f'\\1 {timestamp}',
        content
    )

    # Find the step section and update its COMPLETED_AT
    # This is a simplified update - sets COMPLETED_AT for matching step
    step_pattern = rf'(\*\* (?:TODO|DONE) {re.escape(step_name)}.*?:COMPLETED_AT:)\s*'
    content = re.sub(
        step_pattern,
        f'\\1 {timestamp}\n',
        content,
        flags=re.DOTALL
    )

    with open(workflow_file, 'w') as f:
        f.write(content)

except Exception as e:
    # Silently fail - don't break the workflow
    sys.stderr.write(f"Warning: Could not update org file: {e}\n")
PYTHON_EOF
fi

# Log the update
LOG_FILE="$REPO_ROOT/workflows/hook.log"
echo "[$TIMESTAMP] PostToolUse: $SUBAGENT_TYPE completed for $ACTIVE_WORKFLOW" >> "$LOG_FILE"

exit 0
