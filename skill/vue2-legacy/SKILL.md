---
name: vue2-legacy
description: Vue 2.x Options API patterns with Vuex, mixins, filters, and reactivity caveats
license: MIT
compatibility: opencode
metadata:
  framework: vue
  version: "2.5-2.7"
---

## Options API Structure

```vue
<template>
  <div class="user-profile">
    <div v-if="isLoading">Loading...</div>
    <div v-else-if="errorMessage" class="error">{{ errorMessage }}</div>
    <template v-else>
      <img v-if="showAvatar" :src="user.avatar" :alt="fullName">
      <h2>{{ fullName }}</h2>
      <p>{{ user.created_at | formatDate }}</p>
    </template>
  </div>
</template>

<script>
import { mapState, mapGetters, mapActions } from 'vuex'
import UserMixin from '@/mixins/UserMixin'

export default {
  name: 'UserProfile',
  
  mixins: [UserMixin],
  
  props: {
    userId: {
      type: Number,
      required: true
    },
    showAvatar: {
      type: Boolean,
      default: true
    }
  },
  
  data() {
    return {
      isLoading: false,
      errorMessage: null
    }
  },
  
  computed: {
    ...mapState('user', ['currentUser']),
    ...mapGetters('user', ['isAuthenticated']),
    
    fullName() {
      if (!this.user) return ''
      return `${this.user.firstName} ${this.user.lastName}`
    }
  },
  
  watch: {
    userId: {
      immediate: true,
      handler(newId) {
        this.fetchUser(newId)
      }
    }
  },
  
  created() {
    // Called before mount, no DOM access
  },
  
  mounted() {
    // DOM is available
  },
  
  beforeDestroy() {
    // Cleanup (Vue 2 naming)
  },
  
  methods: {
    ...mapActions('user', ['fetchUserById']),
    
    async fetchUser(id) {
      this.isLoading = true
      this.errorMessage = null
      
      try {
        await this.fetchUserById(id)
      } catch (err) {
        this.errorMessage = 'Failed to load user'
      } finally {
        this.isLoading = false
      }
    }
  }
}
</script>
```

---

## Reactivity Caveats (Vue 2 Specific!)

### Adding New Properties to Objects
```javascript
// BAD - Not reactive!
this.user.newProperty = 'value'

// GOOD - Use Vue.set
this.$set(this.user, 'newProperty', 'value')

// Or replace entire object
this.user = { ...this.user, newProperty: 'value' }
```

### Array Mutation
```javascript
// BAD - These won't trigger updates!
this.items[index] = newValue
this.items.length = 0

// GOOD - Use Vue.set for index
this.$set(this.items, index, newValue)

// GOOD - Use splice for length
this.items.splice(0, this.items.length)

// GOOD - Mutation methods ARE reactive
this.items.push(item)
this.items.splice(index, 1)
this.items.sort()
```

### Async Data Initialization
```javascript
data() {
  return {
    // Define ALL reactive properties upfront
    user: null,        // Will be populated async
    items: [],         // Empty array, not undefined
    settings: {        // Define nested structure
      theme: 'light',
      notifications: true
    }
  }
}
```

---

## Vuex Store Pattern

```javascript
// store/modules/user.js
const state = {
  currentUser: null,
  users: [],
  isLoading: false
}

const getters = {
  isAuthenticated: state => state.currentUser !== null,
  activeUsers: state => state.users.filter(u => u.isActive),
  getUserById: state => id => state.users.find(u => u.id === id)
}

const mutations = {
  SET_CURRENT_USER(state, user) {
    state.currentUser = user
  },
  SET_USERS(state, users) {
    state.users = users
  },
  SET_LOADING(state, isLoading) {
    state.isLoading = isLoading
  },
  // For adding nested properties
  UPDATE_USER_SETTINGS(state, { userId, settings }) {
    const user = state.users.find(u => u.id === userId)
    if (user) {
      // Use Vue.set for new properties
      Vue.set(user, 'settings', settings)
    }
  }
}

const actions = {
  async fetchUsers({ commit }) {
    commit('SET_LOADING', true)
    try {
      const response = await api.getUsers()
      commit('SET_USERS', response.data)
    } finally {
      commit('SET_LOADING', false)
    }
  },
  
  async fetchUserById({ commit }, id) {
    const response = await api.getUser(id)
    commit('SET_CURRENT_USER', response.data)
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
```

### Store Usage in Components
```javascript
import { mapState, mapGetters, mapMutations, mapActions } from 'vuex'

export default {
  computed: {
    // Map state
    ...mapState('user', ['currentUser', 'isLoading']),
    ...mapState({
      user: state => state.user.currentUser
    }),
    
    // Map getters
    ...mapGetters('user', ['isAuthenticated', 'activeUsers'])
  },
  
  methods: {
    // Map mutations (rarely used directly)
    ...mapMutations('user', ['SET_CURRENT_USER']),
    
    // Map actions
    ...mapActions('user', ['fetchUsers', 'fetchUserById'])
  }
}
```

---

## Mixins (Legacy Pattern)

```javascript
// mixins/FormMixin.js
export default {
  data() {
    return {
      isSubmitting: false,
      errors: {}
    }
  },
  
  methods: {
    clearErrors() {
      this.errors = {}
    },
    
    setError(field, message) {
      this.$set(this.errors, field, message)
    },
    
    async submitForm(action) {
      if (this.isSubmitting) return
      
      this.isSubmitting = true
      this.clearErrors()
      
      try {
        await action()
      } catch (err) {
        if (err.response?.data?.errors) {
          this.errors = err.response.data.errors
        }
      } finally {
        this.isSubmitting = false
      }
    }
  }
}

// Usage
import FormMixin from '@/mixins/FormMixin'

export default {
  mixins: [FormMixin],
  
  methods: {
    async save() {
      await this.submitForm(async () => {
        await this.$store.dispatch('user/update', this.form)
      })
    }
  }
}
```

**Note**: Mixins have drawbacks (naming collisions, unclear source). Consider extracting to utility functions where possible.

---

## Filters (Vue 2 Only)

```javascript
// Global filter (main.js)
Vue.filter('formatDate', function(value) {
  if (!value) return ''
  return new Date(value).toLocaleDateString()
})

Vue.filter('currency', function(value, symbol = '$') {
  if (typeof value !== 'number') return value
  return `${symbol}${value.toFixed(2)}`
})

// Local filter
export default {
  filters: {
    truncate(value, length = 50) {
      if (!value || value.length <= length) return value
      return value.substring(0, length) + '...'
    }
  }
}
```

```html
<template>
  <div>
    <p>{{ createdAt | formatDate }}</p>
    <p>{{ price | currency('€') }}</p>
    <p>{{ description | truncate(100) }}</p>
  </div>
</template>
```

---

## Event Bus (Legacy Pattern)

```javascript
// eventBus.js
import Vue from 'vue'
export const EventBus = new Vue()

// Emitting
EventBus.$emit('user-updated', userData)

// Listening (in component)
export default {
  created() {
    EventBus.$on('user-updated', this.handleUserUpdate)
  },
  
  beforeDestroy() {
    // IMPORTANT: Always clean up!
    EventBus.$off('user-updated', this.handleUserUpdate)
  },
  
  methods: {
    handleUserUpdate(data) {
      // Handle event
    }
  }
}
```

**Warning**: Event buses make data flow hard to track. Prefer Vuex or props/events.

---

## Component Communication

### Props Down, Events Up
```vue
<!-- Parent -->
<template>
  <ChildComponent
    :user="selectedUser"
    @update="handleUpdate"
    @delete="handleDelete"
  />
</template>

<!-- Child -->
<script>
export default {
  props: {
    user: {
      type: Object,
      required: true,
      validator(value) {
        return value.id && value.name
      }
    }
  },
  
  methods: {
    save() {
      // Use kebab-case for event names
      this.$emit('update', this.user)
    }
  }
}
</script>
```

### Slots
```vue
<!-- Parent -->
<Card>
  <template v-slot:header>
    <h2>Title</h2>
  </template>
  
  <template v-slot:default>
    <p>Content</p>
  </template>
  
  <template v-slot:footer="{ canSubmit }">
    <button :disabled="!canSubmit">Submit</button>
  </template>
</Card>

<!-- Card.vue -->
<template>
  <div class="card">
    <div class="card-header">
      <slot name="header"></slot>
    </div>
    <div class="card-body">
      <slot></slot>
    </div>
    <div class="card-footer">
      <slot name="footer" :canSubmit="isValid"></slot>
    </div>
  </div>
</template>
```

---

## Lifecycle Hooks (Vue 2)

| Hook | Description |
|------|-------------|
| `beforeCreate` | Before data/methods initialized |
| `created` | Data reactive, no DOM |
| `beforeMount` | Before render |
| `mounted` | DOM available |
| `beforeUpdate` | Before re-render |
| `updated` | After re-render |
| `beforeDestroy` | Before teardown (cleanup here!) |
| `destroyed` | Component destroyed |

---

## Performance Tips

```vue
<template>
  <!-- v-if vs v-show -->
  <Modal v-if="isModalOpen" />     <!-- Destroys/creates DOM -->
  <Tooltip v-show="isHovering" />  <!-- CSS display toggle -->
  
  <!-- Always use :key -->
  <UserCard v-for="user in users" :key="user.id" :user="user" />
  
  <!-- Avoid method calls in templates for repeated renders -->
  <!-- BAD -->
  <div>{{ formatUser(user) }}</div>
  
  <!-- GOOD - use computed -->
  <div>{{ formattedUser }}</div>
</template>

<script>
export default {
  computed: {
    formattedUser() {
      return `${this.user.firstName} ${this.user.lastName}`
    }
  }
}
</script>
```

### Async Components (Code Splitting)
```javascript
// Route level
const UserDashboard = () => import('@/views/UserDashboard.vue')

// Component level
export default {
  components: {
    HeavyChart: () => import('@/components/HeavyChart.vue')
  }
}
```

---

## Common Gotchas

1. **`this` in callbacks** - Use arrow functions or bind
```javascript
// BAD
setTimeout(function() {
  this.isLoading = false // 'this' is wrong!
}, 1000)

// GOOD
setTimeout(() => {
  this.isLoading = false
}, 1000)
```

2. **Mutating props** - Never do this
```javascript
// BAD
this.user.name = 'New Name' // Mutating prop!

// GOOD
this.$emit('update', { ...this.user, name: 'New Name' })
```

3. **Forgetting to unsubscribe** - Memory leaks
```javascript
beforeDestroy() {
  EventBus.$off('event', this.handler)
  window.removeEventListener('resize', this.onResize)
  clearInterval(this.timer)
}
```
