---
description: Bash scripting best practices with error handling, portability, shellcheck compliance, and testing
---

## Script Header

**Always start scripts with proper shebang and safety options:**

```bash
#!/usr/bin/env bash
#
# Script: backup.sh
# Description: Backup user data to remote storage
# Author: Your Name
# Date: 2025-01-15
#

# Exit on error, undefined vars, pipe failures
set -euo pipefail

# Optional: Debug mode
# set -x

# Script directory (works even when sourced)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```

## Safety Options Explained

```bash
set -e          # Exit immediately on error
set -u          # Error on undefined variables
set -o pipefail # Pipe fails if any command fails
set -x          # Print commands before execution (debug)

# Combine them
set -euo pipefail
```

## Variable Handling

```bash
# Always quote variables
name="John Doe"
echo "Hello, ${name}"  # Use ${} for clarity

# Default values
input="${1:-default_value}"        # Use default if not set
required="${1:?Error: missing argument}"  # Error if not set

# Arrays
files=("file1.txt" "file2.txt" "file3.txt")
echo "First: ${files[0]}"
echo "All: ${files[@]}"
echo "Count: ${#files[@]}"

# Loop over array
for file in "${files[@]}"; do
    echo "Processing: ${file}"
done

# Readonly constants
readonly CONFIG_DIR="/etc/myapp"
readonly LOG_FILE="${CONFIG_DIR}/app.log"
```

## Functions

```bash
# Function with local variables and return
process_file() {
    local file="$1"
    local -r output_dir="$2"  # readonly local

    if [[ ! -f "${file}" ]]; then
        echo "Error: File not found: ${file}" >&2
        return 1
    fi

    # Process file...
    cp "${file}" "${output_dir}/"
    return 0
}

# Function with multiple return values (via global)
get_user_info() {
    local username="$1"

    USER_ID=$(id -u "${username}")
    USER_HOME=$(eval echo "~${username}")
    USER_SHELL=$(getent passwd "${username}" | cut -d: -f7)
}

# Usage
if process_file "input.txt" "/tmp"; then
    echo "Success"
else
    echo "Failed"
fi
```

## Conditional Statements

```bash
# Use [[ ]] instead of [ ] (more features, safer)
if [[ -f "${file}" ]]; then
    echo "File exists"
elif [[ -d "${file}" ]]; then
    echo "Is a directory"
else
    echo "Not found"
fi

# String comparison
if [[ "${name}" == "admin" ]]; then
    echo "Welcome, admin"
fi

# Regex matching
if [[ "${email}" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    echo "Valid email"
fi

# Numeric comparison (use (( )) or -eq/-lt/-gt)
if (( count > 10 )); then
    echo "More than 10"
fi

if [[ "${count}" -gt 10 ]]; then
    echo "More than 10"
fi

# Check if variable is set
if [[ -v MY_VAR ]]; then
    echo "MY_VAR is set"
fi

# Check if variable is empty
if [[ -z "${MY_VAR:-}" ]]; then
    echo "MY_VAR is empty or unset"
fi
```

## Error Handling

```bash
# Trap for cleanup
cleanup() {
    local exit_code=$?
    echo "Cleaning up..."
    rm -f "${TEMP_FILE:-}"
    exit "${exit_code}"
}
trap cleanup EXIT

# Error handler
error_handler() {
    local line_no=$1
    local error_code=$2
    echo "Error on line ${line_no}: exit code ${error_code}" >&2
}
trap 'error_handler ${LINENO} $?' ERR

# Safe temporary files
TEMP_FILE=$(mktemp)
TEMP_DIR=$(mktemp -d)

# Check command exists
command_exists() {
    command -v "$1" &> /dev/null
}

if ! command_exists "jq"; then
    echo "Error: jq is required but not installed" >&2
    exit 1
fi
```

## Input Validation

```bash
# Argument count
if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <input_file> <output_dir>" >&2
    exit 1
fi

# Validate file exists
validate_file() {
    local file="$1"
    if [[ ! -f "${file}" ]]; then
        echo "Error: File not found: ${file}" >&2
        return 1
    fi
    if [[ ! -r "${file}" ]]; then
        echo "Error: File not readable: ${file}" >&2
        return 1
    fi
}

# Validate directory
validate_dir() {
    local dir="$1"
    if [[ ! -d "${dir}" ]]; then
        echo "Error: Directory not found: ${dir}" >&2
        return 1
    fi
    if [[ ! -w "${dir}" ]]; then
        echo "Error: Directory not writable: ${dir}" >&2
        return 1
    fi
}

# Sanitize input (prevent injection)
sanitize_filename() {
    local input="$1"
    # Remove path components and dangerous characters
    echo "${input##*/}" | tr -cd '[:alnum:]._-'
}
```

## Logging

```bash
# Log levels
readonly LOG_LEVEL_DEBUG=0
readonly LOG_LEVEL_INFO=1
readonly LOG_LEVEL_WARN=2
readonly LOG_LEVEL_ERROR=3

LOG_LEVEL="${LOG_LEVEL:-${LOG_LEVEL_INFO}}"

log() {
    local level="$1"
    local message="$2"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    if (( level >= LOG_LEVEL )); then
        echo "[${timestamp}] ${message}" >&2
    fi
}

log_debug() { log "${LOG_LEVEL_DEBUG}" "DEBUG: $1"; }
log_info()  { log "${LOG_LEVEL_INFO}"  "INFO:  $1"; }
log_warn()  { log "${LOG_LEVEL_WARN}"  "WARN:  $1"; }
log_error() { log "${LOG_LEVEL_ERROR}" "ERROR: $1"; }

# Usage
log_info "Starting backup process"
log_error "Failed to connect to server"
```

## Argument Parsing

```bash
# Simple positional
input_file="$1"
output_dir="$2"

# With getopts
usage() {
    cat << EOF
Usage: $0 [OPTIONS] <input_file>

Options:
    -o, --output DIR    Output directory (default: current)
    -v, --verbose       Enable verbose output
    -h, --help          Show this help message

Example:
    $0 -o /tmp/output input.txt
EOF
}

# Parse options
VERBOSE=false
OUTPUT_DIR="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            exit 1
            ;;
        *)
            INPUT_FILE="$1"
            shift
            ;;
    esac
done

# Validate required args
if [[ -z "${INPUT_FILE:-}" ]]; then
    echo "Error: input_file is required" >&2
    usage
    exit 1
fi
```

## Safe Command Execution

```bash
# Capture output and exit code
output=$(some_command 2>&1) || {
    echo "Command failed: ${output}" >&2
    exit 1
}

# Run with timeout
if ! timeout 30 long_running_command; then
    echo "Command timed out" >&2
    exit 1
fi

# Retry pattern
retry() {
    local max_attempts="$1"
    local delay="$2"
    shift 2
    local attempt=1

    until "$@"; do
        if (( attempt >= max_attempts )); then
            echo "Command failed after ${max_attempts} attempts" >&2
            return 1
        fi
        echo "Attempt ${attempt} failed, retrying in ${delay}s..." >&2
        sleep "${delay}"
        ((attempt++))
    done
}

# Usage: retry 3 5 curl -f "https://api.example.com/health"
```

## Testing with BATS

```bash
# tests/backup.bats
#!/usr/bin/env bats

setup() {
    TEMP_DIR=$(mktemp -d)
    TEST_FILE="${TEMP_DIR}/test.txt"
    echo "test content" > "${TEST_FILE}"
}

teardown() {
    rm -rf "${TEMP_DIR}"
}

@test "backup creates output file" {
    run ./backup.sh "${TEST_FILE}" "${TEMP_DIR}/output"
    [ "$status" -eq 0 ]
    [ -f "${TEMP_DIR}/output/test.txt" ]
}

@test "backup fails on missing file" {
    run ./backup.sh "/nonexistent" "${TEMP_DIR}/output"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "not found" ]]
}

@test "backup validates output directory" {
    run ./backup.sh "${TEST_FILE}" "/nonexistent/dir"
    [ "$status" -ne 0 ]
}
```

## ShellCheck Compliance

Always run `shellcheck` on your scripts:

```bash
# Install
# apt install shellcheck  # Debian/Ubuntu
# brew install shellcheck # macOS

# Run
shellcheck myscript.sh

# Common fixes:
# SC2086: Double quote to prevent globbing/splitting
# SC2046: Quote command substitution
# SC2034: Variable appears unused (prefix with _)
# SC2155: Declare and assign separately
```

## Portability

```bash
# Prefer POSIX when possible for portability
# But use Bash features when they add safety

# Cross-platform commands
# Instead of: readlink -f (GNU only)
realpath() {
    [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"
}

# Check OS
case "$(uname -s)" in
    Linux*)  OS=Linux;;
    Darwin*) OS=Mac;;
    CYGWIN*) OS=Cygwin;;
    *)       OS="UNKNOWN";;
esac
```

## Internationalization (i18n)

**Even CLI tools benefit from externalized strings:**

```bash
# messages.sh
readonly MSG_FILE_NOT_FOUND="Error: File not found"
readonly MSG_SUCCESS="Operation completed successfully"
readonly MSG_USAGE="Usage: $0 <file>"

# Or load from file
source "${SCRIPT_DIR}/messages_${LANG:-en}.sh"

# Usage
echo "${MSG_FILE_NOT_FOUND}: ${filename}"
```

## Security Checklist

- [ ] `set -euo pipefail` at top
- [ ] All variables quoted: `"${var}"`
- [ ] Input sanitized before use
- [ ] No `eval` with user input
- [ ] Temp files created with `mktemp`
- [ ] Cleanup trap in place
- [ ] `shellcheck` passes
- [ ] No hardcoded credentials
