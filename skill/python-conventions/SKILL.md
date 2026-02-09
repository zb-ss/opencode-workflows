---
description: Python coding standards with type hints, testing (pytest), async patterns, and project structure
---

## Code Style (PEP 8)

- Use `black` for formatting, `isort` for imports, `ruff` or `flake8` for linting
- 4 spaces indentation (never tabs)
- Max line length: 88 (black default) or 79 (strict PEP 8)
- snake_case for functions/variables, PascalCase for classes, UPPER_CASE for constants

## Type Hints (Python 3.9+)

**ALWAYS use type hints for function signatures:**

```python
from typing import Optional, List, Dict, Any, Union
from collections.abc import Sequence, Mapping, Callable

def process_user(
    user_id: int,
    options: dict[str, Any] | None = None
) -> User:
    """Process a user by ID."""
    ...

def fetch_items(
    filters: list[str],
    limit: int = 100
) -> list[Item]:
    ...

# For complex types, use TypeAlias (3.10+) or TypeVar
type UserDict = dict[str, str | int | None]
```

## Project Structure

```
my_project/
├── src/
│   └── my_project/
│       ├── __init__.py
│       ├── main.py
│       ├── models/
│       │   ├── __init__.py
│       │   └── user.py
│       ├── services/
│       │   ├── __init__.py
│       │   └── user_service.py
│       └── utils/
│           └── helpers.py
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── unit/
│   └── integration/
├── pyproject.toml
├── requirements.txt (or poetry.lock)
└── README.md
```

## Classes and Data Classes

```python
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime

@dataclass
class User:
    """User entity."""
    id: int
    email: str
    name: str
    created_at: datetime = field(default_factory=datetime.now)
    is_active: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate after initialization."""
        if not self.email:
            raise ValueError("Email is required")

# For immutable data
@dataclass(frozen=True)
class Config:
    host: str
    port: int
    debug: bool = False
```

## Pydantic Models (API/Validation)

```python
from pydantic import BaseModel, EmailStr, Field, field_validator

class UserCreate(BaseModel):
    """User creation schema."""
    email: EmailStr
    name: str = Field(..., min_length=1, max_length=100)
    age: int = Field(..., ge=0, le=150)

    @field_validator('name')
    @classmethod
    def name_must_not_be_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError('Name cannot be empty')
        return v.strip()

class UserResponse(BaseModel):
    """User response schema."""
    id: int
    email: str
    name: str

    model_config = {"from_attributes": True}
```

## Error Handling

```python
# Custom exceptions
class UserNotFoundError(Exception):
    """Raised when user is not found."""
    def __init__(self, user_id: int) -> None:
        self.user_id = user_id
        super().__init__(f"User {user_id} not found")

# Usage
def get_user(user_id: int) -> User:
    user = db.query(User).filter_by(id=user_id).first()
    if not user:
        raise UserNotFoundError(user_id)
    return user

# Context managers for cleanup
from contextlib import contextmanager

@contextmanager
def database_session():
    session = Session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
```

## Async Patterns

```python
import asyncio
from typing import AsyncGenerator

async def fetch_user(user_id: int) -> User:
    """Fetch user asynchronously."""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"/users/{user_id}")
        response.raise_for_status()
        return User(**response.json())

async def fetch_all_users(user_ids: list[int]) -> list[User]:
    """Fetch multiple users concurrently."""
    tasks = [fetch_user(uid) for uid in user_ids]
    return await asyncio.gather(*tasks)

# Async generator
async def stream_items() -> AsyncGenerator[Item, None]:
    async for item in database.stream():
        yield item
```

## Testing with pytest

```python
# tests/conftest.py
import pytest
from my_project.database import engine, Session

@pytest.fixture
def db_session():
    """Provide a transactional database session."""
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)

    yield session

    session.close()
    transaction.rollback()
    connection.close()

@pytest.fixture
def sample_user(db_session) -> User:
    """Create a sample user for testing."""
    user = User(email="test@example.com", name="Test User")
    db_session.add(user)
    db_session.commit()
    return user

# tests/unit/test_user_service.py
import pytest
from my_project.services.user_service import UserService
from my_project.exceptions import UserNotFoundError

class TestUserService:
    def test_get_user_success(self, db_session, sample_user):
        service = UserService(db_session)
        user = service.get_user(sample_user.id)
        assert user.email == "test@example.com"

    def test_get_user_not_found(self, db_session):
        service = UserService(db_session)
        with pytest.raises(UserNotFoundError) as exc_info:
            service.get_user(99999)
        assert exc_info.value.user_id == 99999

    @pytest.mark.parametrize("email,expected", [
        ("valid@email.com", True),
        ("invalid", False),
        ("", False),
    ])
    def test_validate_email(self, email, expected):
        assert UserService.validate_email(email) == expected
```

## Dependency Injection

```python
from abc import ABC, abstractmethod
from typing import Protocol

# Use Protocol for structural typing
class UserRepository(Protocol):
    def get(self, user_id: int) -> User | None: ...
    def save(self, user: User) -> User: ...

class UserService:
    def __init__(self, repository: UserRepository) -> None:
        self._repository = repository

    def get_user(self, user_id: int) -> User:
        user = self._repository.get(user_id)
        if not user:
            raise UserNotFoundError(user_id)
        return user
```

## Logging

```python
import logging
from typing import Any

logger = logging.getLogger(__name__)

def process_payment(payment_id: int, amount: float) -> bool:
    logger.info("Processing payment", extra={
        "payment_id": payment_id,
        "amount": amount
    })
    try:
        # Process...
        logger.info("Payment successful", extra={"payment_id": payment_id})
        return True
    except Exception as e:
        logger.exception("Payment failed", extra={"payment_id": payment_id})
        return False
```

## Internationalization (i18n)

**NEVER hardcode user-facing strings:**

```python
import gettext
from pathlib import Path

# Setup
localedir = Path(__file__).parent / "locales"
lang = gettext.translation("messages", localedir, languages=["fr"])
_ = lang.gettext

# Usage
message = _("Welcome to our application")
error = _("User {name} not found").format(name=username)

# With Flask-Babel or similar
from flask_babel import gettext as _
flash(_("Settings saved successfully"))
```

## Security Checklist

- [ ] Input validation with Pydantic
- [ ] SQL: Use ORM or parameterized queries
- [ ] No `eval()` or `exec()` with user input
- [ ] Secrets in environment variables, not code
- [ ] Dependencies audited (`pip-audit`, `safety`)
- [ ] No pickle with untrusted data
