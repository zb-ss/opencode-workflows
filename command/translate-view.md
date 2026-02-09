---
description: Process a single view file for translation (part of translation workflow)
agent: translation-coder
model: anthropic/claude-sonnet-4-5
---

Process a single Joomla view file for translation.

## Usage
```
/translate-view <view_path_or_next>
```

## Arguments
- `next` - Process the next PENDING view from the queue
- `<path>` - Process a specific view file

## Examples
```
/translate-view next
/translate-view /path/to/views/lot/tmpl/edit.php
```

## Your Task

You are the translation-coder agent processing ONE view file.

**Input**: $ARGUMENTS

### If argument is "next"

1. Find the active workflow directory:
   ```
   workflows/active/
   ```
   Look for the most recent `*-translate-*` directory.

2. Read `view-queue.org` from that directory

3. Find the FIRST view with status `PENDING`

4. Process that view (see processing steps below)

### If argument is a file path

1. Verify the file exists
2. Process that specific view

## View Processing Steps

### Step 1: Analyze the View

First, understand the file:
```bash
wc -l {view_file}  # Get line count
```

If > 500 lines, you MUST use chunking.

### Step 2: Find ALL Hardcoded Strings

**For small files (<500 lines):**
```
i18n_hardcode_finder(
  filePath="{view_file}",
  minLength=2,
  framework="joomla",
  includeComments=false
)
```

**For large files (>=500 lines):**
```
# Step 1: Create chunks
file_chunker(
  filePath="{view_file}",
  chunkSize=150,
  overlap=20
)

# Step 2: Process EACH chunk
For chunkId in 1..totalChunks:
  chunk_reader(stateFile, chunkId)
  i18n_hardcode_finder(filePath, startLine, endLine)
  chunk_state(stateFile, action="complete", chunkId)

# Step 3: Combine and deduplicate results
```

### Step 3: Convert ALL Strings

**CRITICAL**: Do not skip ANY strings. Process ALL of them.

For EACH hardcoded string found:
```
i18n_convert(
  filePath="{view_file}",
  line={line_number},
  originalText="{the_text}",
  keyName="{suggested_key}",
  type="{string_type}",
  framework="joomla",
  dryRun=false
)
```

Process in this order (by type):
1. `label` - Form labels
2. `heading` - Section headings
3. `placeholder` - Input placeholders
4. `tooltip` - Title attributes
5. `button` - Button text
6. `option` - Select options
7. `table_header` - Table headers
8. `message` - Messages and paragraphs
9. `link_text` - Link text
10. `span_text` - Span content
11. `js_alert` - JavaScript alerts
12. `js_confirm` - JavaScript confirms
13. `js_string` - Other JS strings
14. `vue_ternary` - Vue conditional text
15. `inline_text` - Other inline text

### Step 4: Collect New Keys

After ALL conversions, collect the new keys:
```
New keys from this view:
- COM_LOTS_FIELD_X_LABEL="X"
- COM_LOTS_MSG_Y="Y"
...
```

### Step 5: Update Source INI

```
ini_builder(
  action="add",
  filePath="{component}/administrator/language/en-GB/en-GB.com_{name}.ini",
  strings='[{"key":"COM_...", "value":"..."}]',
  sort=true
)
```

### Step 6: Create Target Translations

Translate each new key to the target language.

For fr-CA, remember:
- "courriel" not "email"
- "téléverser" not "upload"
- Space before : ; ? !
- « guillemets » for quotes
- Formal "vous"

```
ini_builder(
  action="add",
  filePath="{component}/administrator/language/fr-CA/fr-CA.com_{name}.ini",
  strings='[{"key":"COM_...", "value":"..."}]',
  sort=true
)
```

### Step 7: Validate

```bash
php -l {view_file}
```

```
ini_builder(action="validate", filePath="{source_ini}")
ini_builder(action="validate", filePath="{target_ini}")
```

### Step 8: Update Queue Status

If processing from queue, update view-queue.org:
- Change `PENDING` to `DONE`
- Add completion stats

## Output Format

After completing the view:

```
## View Processing Complete

File: {view_file}
Lines: {line_count}
Chunked: Yes/No

### Hardcode Detection
Total found: {N}
By type:
- Labels: {n}
- Placeholders: {n}
- Headings: {n}
- Messages: {n}
- JS strings: {n}
- Other: {n}

### Conversion Results
Converted: {N}
Failed (need manual fix): {N}
Skipped (false positive): {N}

### INI Updates
New keys added to en-GB: {N}
New keys added to fr-CA: {N}

### Validation
PHP syntax: PASS/FAIL
Source INI: VALID/INVALID
Target INI: VALID/INVALID

### Queue Status
Views completed: {N}/{TOTAL}
Next pending: {next_view_name} or "None - all complete!"
```

## Important Notes

1. **Process ONE view completely** before reporting
2. **Do not skip strings** - convert ALL detected hardcoded text
3. **Verify PHP syntax** after conversions
4. **Update INI files** with ALL new keys
5. **Report progress** clearly

If you encounter errors:
- Log the error
- Continue with remaining strings
- Report failed conversions at the end
