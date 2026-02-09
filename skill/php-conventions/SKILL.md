---
name: php-conventions
description: PHP coding standards including strict typing, OOP patterns, error handling, and documentation
license: MIT
compatibility: opencode
metadata:
  language: php
  version: "8.1+"
---

## Strict Typing
- Always enable: `declare(strict_types=1);` at top of files
- Use scalar type hints: `int`, `float`, `string`, `bool`, `array`
- Use specific class/interface type hints
- Return type hints for ALL methods including `void`
- Use `mixed` only when necessary - document why
- Use typed properties (PHP 7.4+)

## Object-Oriented Programming
- Prefer classes over procedural code
- Use `final` for classes not designed for extension
- Use `readonly` for immutable properties (PHP 8.1+)
- Use interfaces for contracts and loose coupling
- Use abstract classes for shared base functionality
- Employ Dependency Injection (constructor injection preferred)
- Avoid static methods for dependencies (except Facades used appropriately)

## Error Handling
- Use Exceptions for exceptional situations only
- Create custom exception classes inheriting from SPL exceptions
- Catch specific exceptions, not base `\Exception` unless re-throwing
- Never use error suppression (`@`)
- Log errors with context using framework logging (Monolog)

## Documentation
- PHPDoc blocks for all classes, properties, methods
- Include `@param`, `@return`, `@throws`
- Document non-obvious behavior

## Code Style
```php
<?php

declare(strict_types=1);

namespace App\Service;

use App\Repository\UserRepositoryInterface;
use App\Exception\UserNotFoundException;

final class UserService
{
    public function __construct(
        private readonly UserRepositoryInterface $user_repository
    ) {}

    /**
     * Find user by ID or throw exception.
     *
     * @throws UserNotFoundException
     */
    public function findOrFail(int $user_id): User
    {
        $user = $this->user_repository->find($user_id);
        
        if ($user === null) {
            throw new UserNotFoundException("User {$user_id} not found");
        }
        
        return $user;
    }
}
```

## Security Checklist
- [ ] Input validated with framework tools
- [ ] SQL uses parameter binding
- [ ] Output escaped in templates
- [ ] CSRF tokens on forms
- [ ] File uploads validated and stored safely
- [ ] Dependencies audited (`composer audit`)
