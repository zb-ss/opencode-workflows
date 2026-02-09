---
name: api-design
description: RESTful API design patterns, HTTP standards, versioning, error handling, and documentation
license: MIT
compatibility: opencode
metadata:
  type: architectural
  protocols: rest, http
---

## RESTful Principles

### Resource Naming
```
# Good - nouns, plural, hierarchical
GET    /api/v1/users
GET    /api/v1/users/{id}
GET    /api/v1/users/{id}/posts
POST   /api/v1/users
PUT    /api/v1/users/{id}
PATCH  /api/v1/users/{id}
DELETE /api/v1/users/{id}

# Bad
GET    /api/v1/getUsers
POST   /api/v1/createUser
GET    /api/v1/user/list
```

### HTTP Methods
| Method | Purpose | Idempotent | Safe |
|--------|---------|------------|------|
| GET | Retrieve resource | Yes | Yes |
| POST | Create resource | No | No |
| PUT | Replace resource | Yes | No |
| PATCH | Partial update | No | No |
| DELETE | Remove resource | Yes | No |

---

## HTTP Status Codes

### Success (2xx)
| Code | Use Case |
|------|----------|
| 200 | OK - GET, PUT, PATCH success |
| 201 | Created - POST success, include Location header |
| 204 | No Content - DELETE success |

### Client Errors (4xx)
| Code | Use Case |
|------|----------|
| 400 | Bad Request - malformed syntax |
| 401 | Unauthorized - authentication required |
| 403 | Forbidden - authenticated but not allowed |
| 404 | Not Found - resource doesn't exist |
| 409 | Conflict - state conflict (duplicate, etc.) |
| 422 | Unprocessable Entity - validation failed |
| 429 | Too Many Requests - rate limited |

### Server Errors (5xx)
| Code | Use Case |
|------|----------|
| 500 | Internal Server Error - unexpected failure |
| 502 | Bad Gateway - upstream service failed |
| 503 | Service Unavailable - temporarily down |

---

## Response Format

### Success Response
```json
{
  "data": {
    "id": 123,
    "name": "John Doe",
    "email": "john@example.com",
    "created_at": "2024-01-15T10:30:00Z"
  }
}
```

### Collection Response
```json
{
  "data": [
    { "id": 1, "name": "John" },
    { "id": 2, "name": "Jane" }
  ],
  "meta": {
    "total": 100,
    "page": 1,
    "per_page": 20,
    "last_page": 5
  },
  "links": {
    "first": "/api/v1/users?page=1",
    "last": "/api/v1/users?page=5",
    "prev": null,
    "next": "/api/v1/users?page=2"
  }
}
```

### Error Response
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The given data was invalid.",
    "details": [
      {
        "field": "email",
        "message": "The email has already been taken."
      },
      {
        "field": "password",
        "message": "The password must be at least 8 characters."
      }
    ]
  }
}
```

---

## Versioning

### URL Path (Recommended)
```
/api/v1/users
/api/v2/users
```

### Header
```
Accept: application/vnd.myapp.v1+json
```

### Query Parameter
```
/api/users?version=1
```

---

## Filtering, Sorting, Pagination

```
# Filtering
GET /api/v1/users?status=active&role=admin

# Sorting
GET /api/v1/users?sort=created_at&order=desc
GET /api/v1/users?sort=-created_at  # Prefix minus for desc

# Pagination
GET /api/v1/users?page=2&per_page=20

# Field selection
GET /api/v1/users?fields=id,name,email

# Combining
GET /api/v1/users?status=active&sort=-created_at&page=1&per_page=10
```

---

## Authentication

### Bearer Token
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### API Key
```
X-API-Key: your-api-key
```

---

## Rate Limiting Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
Retry-After: 60
```

---

## HATEOAS (Hypermedia)

```json
{
  "data": {
    "id": 123,
    "name": "John Doe"
  },
  "links": {
    "self": "/api/v1/users/123",
    "posts": "/api/v1/users/123/posts",
    "avatar": "/api/v1/users/123/avatar"
  },
  "actions": {
    "update": { "method": "PUT", "href": "/api/v1/users/123" },
    "delete": { "method": "DELETE", "href": "/api/v1/users/123" }
  }
}
```

---

## Security Checklist

- [ ] Use HTTPS only
- [ ] Validate all input
- [ ] Authenticate every request (except public endpoints)
- [ ] Authorize resource access
- [ ] Rate limit to prevent abuse
- [ ] Don't expose sensitive data in errors
- [ ] Log all requests (without sensitive data)
- [ ] Use CORS appropriately
- [ ] Validate Content-Type headers

---

## PHP Implementation Example

```php
// Laravel Controller
public function index(Request $request): JsonResponse
{
    $users = User::query()
        ->when($request->status, fn($q, $status) => $q->where('status', $status))
        ->when($request->sort, fn($q, $sort) => $q->orderBy($sort, $request->order ?? 'asc'))
        ->paginate($request->per_page ?? 20);
    
    return UserResource::collection($users);
}

public function store(StoreUserRequest $request): JsonResponse
{
    $user = User::create($request->validated());
    
    return response()->json(
        ['data' => new UserResource($user)],
        201,
        ['Location' => route('users.show', $user)]
    );
}
```
