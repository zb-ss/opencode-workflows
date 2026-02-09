---
name: vue-conventions
description: Vue 3 Composition API patterns with TypeScript, Pinia, composables, and performance
license: MIT
compatibility: opencode
metadata:
  framework: vue
  version: "3.0+"
---

## Composition API with `<script setup>`

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useUserStore } from '@/stores/user'
import type { User } from '@/types'

// Props with defaults
const props = withDefaults(defineProps<{
  userId: number
  showAvatar?: boolean
}>(), {
  showAvatar: true
})

// Emits with types
const emit = defineEmits<{
  (e: 'update', user: User): void
  (e: 'delete', id: number): void
}>()

// Reactive state
const is_loading = ref(false)
const error_message = ref<string | null>(null)

// Store
const user_store = useUserStore()

// Computed
const full_name = computed(() => 
  `${user_store.current_user?.first_name} ${user_store.current_user?.last_name}`
)

// Methods
async function fetchUser(): Promise<void> {
  is_loading.value = true
  try {
    await user_store.fetchUser(props.userId)
  } catch (err) {
    error_message.value = 'Failed to load user'
  } finally {
    is_loading.value = false
  }
}

// Lifecycle
onMounted(() => {
  fetchUser()
})
</script>

<template>
  <div class="user-profile">
    <div v-if="is_loading">Loading...</div>
    <div v-else-if="error_message" class="error">{{ error_message }}</div>
    <template v-else>
      <img v-if="showAvatar" :src="user_store.current_user?.avatar" :alt="full_name">
      <h2>{{ full_name }}</h2>
    </template>
  </div>
</template>
```

## Composables (Reusable Logic)

```typescript
// composables/useApi.ts
import { ref, type Ref } from 'vue'

interface UseApiReturn<T> {
  data: Ref<T | null>
  error: Ref<string | null>
  is_loading: Ref<boolean>
  execute: () => Promise<void>
}

export function useApi<T>(url: string): UseApiReturn<T> {
  const data = ref<T | null>(null) as Ref<T | null>
  const error = ref<string | null>(null)
  const is_loading = ref(false)
  
  async function execute(): Promise<void> {
    is_loading.value = true
    error.value = null
    
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error('Request failed')
      data.value = await response.json()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error'
    } finally {
      is_loading.value = false
    }
  }
  
  return { data, error, is_loading, execute }
}
```

## Pinia Store

```typescript
// stores/user.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'

export const useUserStore = defineStore('user', () => {
  // State
  const current_user = ref<User | null>(null)
  const users = ref<User[]>([])
  
  // Getters
  const is_authenticated = computed(() => current_user.value !== null)
  const active_users = computed(() => users.value.filter(u => u.is_active))
  
  // Actions
  async function fetchUser(id: number): Promise<void> {
    const response = await fetch(`/api/users/${id}`)
    current_user.value = await response.json()
  }
  
  function logout(): void {
    current_user.value = null
  }
  
  return {
    current_user,
    users,
    is_authenticated,
    active_users,
    fetchUser,
    logout
  }
})
```

## Component Communication

```vue
<!-- Parent -->
<template>
  <ChildComponent
    :user="selected_user"
    @update="handleUpdate"
    @delete="handleDelete"
  >
    <template #header>
      <h2>Custom Header</h2>
    </template>
  </ChildComponent>
</template>

<!-- Child with slots -->
<template>
  <div>
    <slot name="header">
      <h2>Default Header</h2>
    </slot>
    <div>{{ user.name }}</div>
    <button @click="$emit('update', user)">Update</button>
  </div>
</template>
```

## Performance Patterns

```vue
<script setup lang="ts">
import { defineAsyncComponent, shallowRef } from 'vue'

// Lazy load heavy components
const HeavyChart = defineAsyncComponent(() => 
  import('@/components/HeavyChart.vue')
)

// Use shallowRef for large objects that don't need deep reactivity
const large_dataset = shallowRef<DataPoint[]>([])
</script>

<template>
  <!-- v-if for rarely shown elements -->
  <Modal v-if="is_modal_open" />
  
  <!-- v-show for frequently toggled -->
  <Tooltip v-show="is_hovering" />
  
  <!-- Always use key with v-for -->
  <UserCard 
    v-for="user in users" 
    :key="user.id" 
    :user="user"
  />
  
  <!-- Suspense for async components -->
  <Suspense>
    <template #default>
      <HeavyChart :data="chart_data" />
    </template>
    <template #fallback>
      <LoadingSpinner />
    </template>
  </Suspense>
</template>
```

## TypeScript Types

```typescript
// types/index.ts
export interface User {
  id: number
  first_name: string
  last_name: string
  email: string
  avatar?: string
  is_active: boolean
  created_at: string
}

export interface ApiResponse<T> {
  data: T
  meta?: {
    total: number
    page: number
    per_page: number
  }
}

// Props type
export interface UserCardProps {
  user: User
  show_actions?: boolean
}
```

## Error Handling

```typescript
// Global error handler in main.ts
app.config.errorHandler = (err, instance, info) => {
  console.error('Global error:', err)
  // Send to error tracking service
}

// Component-level
import { onErrorCaptured } from 'vue'

onErrorCaptured((err, instance, info) => {
  error_message.value = 'Something went wrong'
  return false // Prevent propagation
})
```

## Security
- Never trust client validation - validate on backend
- Use `v-html` only with sanitized content (DOMPurify)
- Include CSRF tokens in API requests
- Sanitize user input before display
