---
name: laravel-conventions
description: Laravel best practices for Eloquent, controllers, validation, services, and testing
license: MIT
compatibility: opencode
metadata:
  framework: laravel
  version: "10+"
---

## Core Patterns

### Use Framework Features
- Eloquent ORM for database operations
- Blade templating with `{{ }}` for auto-escaping
- Service Providers for bootstrapping
- Middleware for request/response filtering
- Form Requests for validation
- Queues for async tasks
- Events for decoupling
- Artisan commands for CLI

### Directory Structure
Follow standard Laravel conventions:
- `app/Http/Controllers/` - Thin controllers
- `app/Services/` - Business logic
- `app/Repositories/` - Data access (optional)
- `app/Actions/` - Single-purpose classes
- `app/Models/` - Eloquent models

## Eloquent Best Practices

```php
// Model definition
class User extends Model
{
    protected $fillable = ['name', 'email'];
    
    protected $casts = [
        'email_verified_at' => 'datetime',
        'is_active' => 'boolean',
    ];
    
    // Relationships
    public function posts(): HasMany
    {
        return $this->hasMany(Post::class);
    }
    
    // Scopes
    public function scopeActive(Builder $query): Builder
    {
        return $query->where('is_active', true);
    }
}

// Eager loading - AVOID N+1
$users = User::with(['posts', 'profile'])->get();

// Select only needed columns
$users = User::select(['id', 'name', 'email'])->get();
```

## Controllers

Keep controllers thin - delegate to services:

```php
class UserController extends Controller
{
    public function store(StoreUserRequest $request, UserService $service): JsonResponse
    {
        $user = $service->create($request->validated());
        
        return response()->json(new UserResource($user), 201);
    }
}
```

## Form Requests

```php
class StoreUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Or policy check
    }
    
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'unique:users'],
            'password' => ['required', 'min:8', 'confirmed'],
        ];
    }
}
```

## API Resources

```php
class UserResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'created_at' => $this->created_at->toISOString(),
            'posts' => PostResource::collection($this->whenLoaded('posts')),
        ];
    }
}
```

## Services Pattern

```php
final class UserService
{
    public function __construct(
        private readonly UserRepositoryInterface $users
    ) {}
    
    public function create(array $data): User
    {
        return DB::transaction(function () use ($data) {
            $user = $this->users->create($data);
            event(new UserCreated($user));
            return $user;
        });
    }
}
```

## Testing

```php
// Feature test
public function test_user_can_be_created(): void
{
    $response = $this->postJson('/api/users', [
        'name' => 'John Doe',
        'email' => 'john@example.com',
        'password' => 'password123',
        'password_confirmation' => 'password123',
    ]);
    
    $response->assertStatus(201)
        ->assertJsonStructure(['data' => ['id', 'name', 'email']]);
    
    $this->assertDatabaseHas('users', ['email' => 'john@example.com']);
}
```

## Performance Tips
- Use `->select()` to limit columns
- Use `->with()` for eager loading
- Use `->chunk()` for large datasets
- Cache expensive queries
- Use queues for slow operations
- Index frequently queried columns
