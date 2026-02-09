---
name: performance-guide
description: Performance optimization for PHP, JavaScript, databases, and caching strategies
license: MIT
compatibility: opencode
metadata:
  type: optimization
  languages: php, javascript, sql
---

## Database Performance

### N+1 Problem

**Problem:**
```php
$users = User::all();
foreach ($users as $user) {
    echo $user->profile->bio; // Query per user!
}
// 1 query for users + N queries for profiles = N+1
```

**Solution - Eager Loading:**
```php
// Laravel
$users = User::with('profile')->get();

// Doctrine
$qb->select('u', 'p')
   ->from(User::class, 'u')
   ->leftJoin('u.profile', 'p');

// Joomla
$query->select($db->quoteName(['u.*', 'p.bio']))
    ->from($db->quoteName('#__users', 'u'))
    ->leftJoin($db->quoteName('#__profiles', 'p') . ' ON p.user_id = u.id');
```

### Select Only Needed Columns

```php
// Bad
$users = User::all(); // SELECT *

// Good
$users = User::select(['id', 'name', 'email'])->get();
```

### Indexing Strategy

```sql
-- Index columns used in:
-- WHERE clauses
CREATE INDEX idx_users_status ON users(status);

-- JOIN conditions
CREATE INDEX idx_orders_user_id ON orders(user_id);

-- ORDER BY
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);

-- Composite for common queries
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
```

### Query Analysis

```sql
-- MySQL
EXPLAIN SELECT * FROM users WHERE status = 'active';

-- Look for:
-- type: ALL (bad) vs index/ref (good)
-- rows: Lower is better
-- Extra: "Using filesort" or "Using temporary" = potential issue
```

### Chunking Large Datasets

```php
// Bad - loads all into memory
User::all()->each(fn($user) => process($user));

// Good - processes in chunks
User::chunk(1000, function ($users) {
    foreach ($users as $user) {
        process($user);
    }
});

// Laravel lazy collection
User::lazy()->each(fn($user) => process($user));
```

---

## PHP Performance

### Avoid Computation in Loops

```php
// Bad
foreach ($items as $item) {
    $count = count($items); // Recalculated each iteration
    // ...
}

// Good
$count = count($items);
foreach ($items as $item) {
    // Use $count
}
```

### Use Appropriate Data Structures

```php
// For checking existence - O(1) vs O(n)
// Bad
$allowed = ['admin', 'moderator', 'user'];
if (in_array($role, $allowed)) { }

// Good
$allowed = ['admin' => true, 'moderator' => true, 'user' => true];
if (isset($allowed[$role])) { }
```

### String Concatenation

```php
// Bad for many concatenations
$html = '';
foreach ($items as $item) {
    $html .= '<li>' . $item . '</li>';
}

// Better
$parts = [];
foreach ($items as $item) {
    $parts[] = '<li>' . $item . '</li>';
}
$html = implode('', $parts);

// Best - use output buffering or templates
```

### Generators for Large Data

```php
// Bad - loads all into memory
function getUsers(): array
{
    return User::all()->toArray();
}

// Good - yields one at a time
function getUsers(): Generator
{
    foreach (User::cursor() as $user) {
        yield $user;
    }
}
```

---

## JavaScript/Vue Performance

### Virtual DOM Optimization

```vue
<template>
  <!-- Use v-once for static content -->
  <header v-once>{{ staticTitle }}</header>
  
  <!-- Use v-memo for expensive re-renders -->
  <div v-memo="[item.id, item.selected]">
    <ExpensiveComponent :item="item" />
  </div>
  
  <!-- Always key v-for -->
  <div v-for="item in items" :key="item.id">
    {{ item.name }}
  </div>
</template>
```

### Lazy Loading

```typescript
// Components
const HeavyComponent = defineAsyncComponent(() =>
  import('./HeavyComponent.vue')
)

// Routes
const routes = [
  {
    path: '/dashboard',
    component: () => import('./views/Dashboard.vue')
  }
]
```

### Debounce & Throttle

```typescript
import { useDebounceFn, useThrottleFn } from '@vueuse/core'

// Debounce - wait until user stops typing
const search = useDebounceFn((query: string) => {
  fetchResults(query)
}, 300)

// Throttle - max once per interval
const scroll = useThrottleFn(() => {
  updateScrollPosition()
}, 100)
```

### Web Workers for Heavy Computation

```typescript
// worker.ts
self.onmessage = (e) => {
  const result = heavyComputation(e.data)
  self.postMessage(result)
}

// main.ts
const worker = new Worker('./worker.ts')
worker.postMessage(data)
worker.onmessage = (e) => {
  result.value = e.data
}
```

---

## Caching Strategies

### Cache Layers

```
Request → Application Cache → Database Cache → Database
            (Redis/Memcached)    (Query Cache)
```

### Laravel Example

```php
// Simple cache
$users = Cache::remember('users:active', 3600, function () {
    return User::where('status', 'active')->get();
});

// Tagged cache (for invalidation)
Cache::tags(['users'])->put("user:{$id}", $user, 3600);
Cache::tags(['users'])->flush(); // Clear all user cache

// Cache with lock (prevent stampede)
$users = Cache::lock('users:lock')->block(5, function () {
    return Cache::remember('users:all', 3600, fn() => User::all());
});
```

### HTTP Caching Headers

```php
return response($content)
    ->header('Cache-Control', 'public, max-age=3600')
    ->header('ETag', md5($content));
```

---

## Profiling Tools

| Tool | Use Case |
|------|----------|
| Xdebug | PHP step debugging & profiling |
| Blackfire | PHP performance profiling |
| Laravel Telescope | Request/query debugging |
| Symfony Profiler | Built-in profiling toolbar |
| Chrome DevTools | JS performance & network |
| Vue DevTools | Component render performance |
| `EXPLAIN ANALYZE` | SQL query analysis |

---

## Quick Wins Checklist

- [ ] Enable OPcache for PHP
- [ ] Use Redis/Memcached for sessions & cache
- [ ] Enable gzip compression
- [ ] Minify CSS/JS assets
- [ ] Use CDN for static assets
- [ ] Optimize images (WebP, lazy loading)
- [ ] Database indexes on foreign keys & filtered columns
- [ ] Eager load relationships
- [ ] Queue slow operations (email, reports)
- [ ] Use HTTP/2
