---
description: Fully automatic Joomla translation workflow with review loop
agent: supervisor
model_tier: mid
---

# Auto Translation Workflow

**Component**: $1
**Target**: $2

## Loop

```
1. workflow_translate_init(componentPath="$1", targetLanguage="$2") OR workflow_translate_next()
2. Get view from response
3. @translation-coder with EXACT path from response
4. workflow_translate_view_done(...)
5. @translation-reviewer 
6. workflow_translate_review(...)
7. Repeat until complete
```

## Call @translation-coder

Use the EXACT path from `workflow_translate_next()` response.

**Small file:**
```
@translation-coder
TARGET: {view.path}
COMPONENT: com_{componentName}
INI: {sourceIniPath} → {targetIniPath}
LANG: {targetLanguage}
```

**Large file (needsChunking=true):**
```
@translation-coder
TARGET: {view.path}
COMPONENT: com_{componentName}
LINES: {view.lines} (USE CHUNKING)
INI: {sourceIniPath} → {targetIniPath}
LANG: {targetLanguage}
```

## After coder, mark done:
```
workflow_translate_view_done(workflowId, viewPath, stringsFound, stringsConverted, errors)
```

## Call @translation-reviewer
```
@translation-reviewer
VIEW: {view.path}
INI: {sourceIniPath} → {targetIniPath}
```

## After reviewer:
```
workflow_translate_review(workflowId, viewPath, passed, issues)
```

## Final
When `workflow_translate_next()` returns complete:
```
workflow_translate_status(workflowId)
```

Output: `DONE: {n} views, {n} strings` or `PARTIAL: {n}/{total} views, {errors}`
