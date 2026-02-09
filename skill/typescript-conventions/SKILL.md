---
description: TypeScript strict mode, type patterns, Node.js/Deno, testing with Vitest/Jest, and project structure
---

## Strict TypeScript Configuration

**Always use strict mode. No exceptions.**

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Code Style

- Use `prettier` for formatting, `eslint` with `@typescript-eslint` for linting
- camelCase for variables/functions, PascalCase for types/classes, UPPER_CASE for constants
- Prefer `const` over `let`, never use `var`
- Use template literals over string concatenation

## Type Definitions

```typescript
// Prefer interfaces for objects that can be extended
interface User {
  id: number;
  email: string;
  name: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

// Use type for unions, intersections, mapped types
type UserId = number | string;
type UserWithPosts = User & { posts: Post[] };
type UserKeys = keyof User;

// Const assertions for literal types
const ROLES = ['admin', 'user', 'guest'] as const;
type Role = (typeof ROLES)[number]; // 'admin' | 'user' | 'guest'

// Generic types
interface ApiResponse<T> {
  data: T;
  meta: {
    total: number;
    page: number;
    perPage: number;
  };
}

// Utility types
type PartialUser = Partial<User>;
type RequiredUser = Required<User>;
type ReadonlyUser = Readonly<User>;
type UserWithoutId = Omit<User, 'id'>;
type UserIdAndEmail = Pick<User, 'id' | 'email'>;
```

## Function Signatures

```typescript
// Always type parameters and return values
function processUser(userId: number, options?: ProcessOptions): Promise<User> {
  // ...
}

// Arrow functions
const calculateTotal = (items: Item[]): number => {
  return items.reduce((sum, item) => sum + item.price, 0);
};

// Generic functions
function findById<T extends { id: number }>(
  items: T[],
  id: number
): T | undefined {
  return items.find(item => item.id === id);
}

// Overloads for complex signatures
function createElement(tag: 'div'): HTMLDivElement;
function createElement(tag: 'span'): HTMLSpanElement;
function createElement(tag: string): HTMLElement {
  return document.createElement(tag);
}
```

## Classes and OOP

```typescript
interface UserRepository {
  findById(id: number): Promise<User | null>;
  save(user: User): Promise<User>;
  delete(id: number): Promise<void>;
}

class PostgresUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: number): Promise<User | null> {
    const result = await this.db.query<User>(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  async save(user: User): Promise<User> {
    // Implementation
  }

  async delete(id: number): Promise<void> {
    // Implementation
  }
}

// Service with dependency injection
class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly logger: Logger
  ) {}

  async getUser(id: number): Promise<User> {
    const user = await this.userRepo.findById(id);
    if (!user) {
      throw new UserNotFoundError(id);
    }
    return user;
  }
}
```

## Error Handling

```typescript
// Custom error classes
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

class UserNotFoundError extends AppError {
  constructor(userId: number) {
    super(`User ${userId} not found`, 'USER_NOT_FOUND', 404);
  }
}

class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly errors: Record<string, string[]>
  ) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

// Type-safe error handling
function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

// Result type pattern (alternative to exceptions)
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function parseJson<T>(json: string): Result<T> {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}
```

## Async Patterns

```typescript
// Async/await with proper typing
async function fetchUsers(ids: number[]): Promise<User[]> {
  const promises = ids.map(id => fetchUser(id));
  return Promise.all(promises);
}

// With error handling
async function fetchUserSafe(id: number): Promise<User | null> {
  try {
    return await fetchUser(id);
  } catch (error) {
    logger.error('Failed to fetch user', { id, error });
    return null;
  }
}

// Concurrent with limit
import pLimit from 'p-limit';

const limit = pLimit(5); // Max 5 concurrent

async function fetchAllUsers(ids: number[]): Promise<User[]> {
  const promises = ids.map(id => limit(() => fetchUser(id)));
  return Promise.all(promises);
}
```

## Validation (Zod)

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  age: z.number().int().min(0).max(150),
  role: z.enum(['admin', 'user', 'guest']),
});

type User = z.infer<typeof UserSchema>;

function validateUser(data: unknown): User {
  return UserSchema.parse(data); // Throws on invalid
}

function safeValidateUser(data: unknown): Result<User> {
  const result = UserSchema.safeParse(data);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, error: new ValidationError('Invalid user', result.error.flatten().fieldErrors) };
}
```

## Testing with Vitest

```typescript
// user.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserService } from './user.service';
import type { UserRepository } from './user.repository';

describe('UserService', () => {
  let service: UserService;
  let mockRepo: UserRepository;

  beforeEach(() => {
    mockRepo = {
      findById: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    };
    service = new UserService(mockRepo, console);
  });

  describe('getUser', () => {
    it('returns user when found', async () => {
      const user = { id: 1, email: 'test@example.com', name: 'Test' };
      vi.mocked(mockRepo.findById).mockResolvedValue(user);

      const result = await service.getUser(1);

      expect(result).toEqual(user);
      expect(mockRepo.findById).toHaveBeenCalledWith(1);
    });

    it('throws UserNotFoundError when not found', async () => {
      vi.mocked(mockRepo.findById).mockResolvedValue(null);

      await expect(service.getUser(1)).rejects.toThrow(UserNotFoundError);
    });
  });
});
```

## Internationalization (i18n)

**NEVER hardcode user-facing strings:**

```typescript
// With i18next
import i18next from 'i18next';

// Setup
await i18next.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        welcome: 'Welcome, {{name}}!',
        items: '{{count}} item',
        items_plural: '{{count}} items',
      },
    },
  },
});

// Usage
const t = i18next.t;
const message = t('welcome', { name: 'John' });
const itemsMsg = t('items', { count: 5 }); // "5 items"

// With typed keys (type-safe)
type TranslationKeys = 'welcome' | 'items' | 'error.notFound';
function translate(key: TranslationKeys, params?: Record<string, unknown>): string {
  return i18next.t(key, params);
}
```

## Project Structure

```
my-project/
├── src/
│   ├── index.ts           # Entry point
│   ├── config/
│   │   └── index.ts       # Configuration
│   ├── modules/
│   │   └── user/
│   │       ├── user.controller.ts
│   │       ├── user.service.ts
│   │       ├── user.repository.ts
│   │       ├── user.types.ts
│   │       └── user.test.ts
│   ├── shared/
│   │   ├── errors/
│   │   ├── utils/
│   │   └── types/
│   └── middleware/
├── tests/
│   ├── integration/
│   └── e2e/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Security Checklist

- [ ] Input validation with Zod/Yup
- [ ] No `any` types (use `unknown` if needed)
- [ ] No `eval()` or `Function()` with user input
- [ ] SQL: Use parameterized queries
- [ ] Environment variables for secrets
- [ ] Dependencies audited (`npm audit`)
- [ ] XSS prevention (sanitize HTML output)
