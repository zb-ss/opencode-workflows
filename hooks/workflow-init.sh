#!/bin/bash
# Workflow initialization hook
# Called by UserPromptSubmit hook when /workflow command is detected
# Creates workflow org file from template

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

# Read the user prompt from stdin
USER_PROMPT=$(cat)

# Parse workflow type and description
# Expected format: /workflow <type> <description...>
WORKFLOW_ARGS=$(echo "$USER_PROMPT" | sed 's|^/workflow\s*||i')
WORKFLOW_TYPE=$(echo "$WORKFLOW_ARGS" | awk '{print $1}')
WORKFLOW_DESC=$(echo "$WORKFLOW_ARGS" | sed 's|^[^ ]*\s*||')

# Validate workflow type
TEMPLATE_DIR="$REPO_ROOT/templates"
TEMPLATE_FILE="$TEMPLATE_DIR/${WORKFLOW_TYPE}-development.org"

if [[ ! -f "$TEMPLATE_FILE" ]]; then
    # Try without -development suffix
    TEMPLATE_FILE="$TEMPLATE_DIR/${WORKFLOW_TYPE}.org"
fi

if [[ ! -f "$TEMPLATE_FILE" ]]; then
    echo "Unknown workflow type: $WORKFLOW_TYPE"
    echo "Available types: $(ls $TEMPLATE_DIR/*.org 2>/dev/null | xargs -n1 basename | sed 's|\.org$||' | sed 's|-development$||' | tr '\n' ' ')"
    exit 0
fi

# Generate workflow ID
WORKFLOW_ID="$(date +%Y%m%d)-$(openssl rand -hex 4)"

# Get current date/time
DATE=$(date '+%Y-%m-%d')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Create title from description (first 50 chars)
TITLE=$(echo "$WORKFLOW_DESC" | cut -c1-50)

# Get current git branch if in a git repo
if git rev-parse --git-dir > /dev/null 2>&1; then
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
else
    CURRENT_BRANCH="N/A"
fi

# Create workflow file
WORKFLOW_DIR="$REPO_ROOT/workflows/active"
WORKFLOW_FILE="$WORKFLOW_DIR/${WORKFLOW_ID}.org"

# Copy template and replace placeholders
cp "$TEMPLATE_FILE" "$WORKFLOW_FILE"

# Replace all placeholders
sed -i "s|{{WORKFLOW_ID}}|$WORKFLOW_ID|g" "$WORKFLOW_FILE"
sed -i "s|{{TITLE}}|$TITLE|g" "$WORKFLOW_FILE"
sed -i "s|{{DATE}}|$DATE|g" "$WORKFLOW_FILE"
sed -i "s|{{TIMESTAMP}}|$TIMESTAMP|g" "$WORKFLOW_FILE"
sed -i "s|{{DESCRIPTION}}|$WORKFLOW_DESC|g" "$WORKFLOW_FILE"
sed -i "s|{{BRANCH}}|pending|g" "$WORKFLOW_FILE"
sed -i "s|{{BASE_BRANCH}}|$CURRENT_BRANCH|g" "$WORKFLOW_FILE"

# Log initialization
LOG_FILE="$REPO_ROOT/workflows/hook.log"
echo "[$TIMESTAMP] Workflow initialized: $WORKFLOW_ID ($WORKFLOW_TYPE)" >> "$LOG_FILE"

# Output info that will be visible in hook output
echo "WORKFLOW_INITIALIZED"
echo "ID: $WORKFLOW_ID"
echo "FILE: $WORKFLOW_FILE"
echo "TYPE: $WORKFLOW_TYPE"

exit 0
