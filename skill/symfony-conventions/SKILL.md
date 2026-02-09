---
name: symfony-conventions
description: Symfony best practices for services, Doctrine, Twig, forms, and dependency injection
license: MIT
compatibility: opencode
metadata:
  framework: symfony
  version: "6.0+"
---

## Core Architecture

### Use Framework Features
- Doctrine ORM for database operations
- Twig templating with auto-escaping
- Dependency Injection Container (autowiring)
- Messenger for async/queues
- Form component for validation
- Security component for auth
- Event Dispatcher for decoupling

### Directory Structure
```
src/
├── Controller/
├── Entity/
├── Repository/
├── Service/
├── EventSubscriber/
├── Form/
├── Security/
└── Twig/
```

## Controllers

Keep controllers thin, use autowiring:

```php
<?php

declare(strict_types=1);

namespace App\Controller;

use App\Service\UserService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Annotation\Route;

#[Route('/api/users')]
final class UserController extends AbstractController
{
    public function __construct(
        private readonly UserService $user_service
    ) {}
    
    #[Route('', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $data = json_decode($request->getContent(), true);
        $user = $this->user_service->create($data);
        
        return $this->json($user, 201);
    }
}
```

## Doctrine Entities

```php
<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\UserRepository;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Validator\Constraints as Assert;

#[ORM\Entity(repositoryClass: UserRepository::class)]
#[ORM\Table(name: 'users')]
class User
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;
    
    #[ORM\Column(length: 255)]
    #[Assert\NotBlank]
    #[Assert\Length(max: 255)]
    private string $name;
    
    #[ORM\Column(length: 255, unique: true)]
    #[Assert\NotBlank]
    #[Assert\Email]
    private string $email;
    
    #[ORM\OneToMany(mappedBy: 'author', targetEntity: Post::class)]
    private Collection $posts;
    
    public function __construct()
    {
        $this->posts = new ArrayCollection();
    }
    
    // Getters and setters...
}
```

## Repositories

```php
<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<User>
 */
final class UserRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, User::class);
    }
    
    /**
     * @return User[]
     */
    public function findActiveUsers(): array
    {
        return $this->createQueryBuilder('u')
            ->andWhere('u.is_active = :active')
            ->setParameter('active', true)
            ->orderBy('u.created_at', 'DESC')
            ->getQuery()
            ->getResult();
    }
}
```

## Services

```php
<?php

declare(strict_types=1);

namespace App\Service;

use App\Entity\User;
use App\Repository\UserRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;

final class UserService
{
    public function __construct(
        private readonly EntityManagerInterface $entity_manager,
        private readonly UserRepository $user_repository,
        private readonly UserPasswordHasherInterface $password_hasher
    ) {}
    
    public function create(array $data): User
    {
        $user = new User();
        $user->setName($data['name']);
        $user->setEmail($data['email']);
        $user->setPassword($this->password_hasher->hashPassword($user, $data['password']));
        
        $this->entity_manager->persist($user);
        $this->entity_manager->flush();
        
        return $user;
    }
}
```

## Form Types

```php
<?php

declare(strict_types=1);

namespace App\Form;

use App\Entity\User;
use Symfony\Component\Form\AbstractType;
use Symfony\Component\Form\Extension\Core\Type\EmailType;
use Symfony\Component\Form\Extension\Core\Type\PasswordType;
use Symfony\Component\Form\Extension\Core\Type\TextType;
use Symfony\Component\Form\FormBuilderInterface;
use Symfony\Component\OptionsResolver\OptionsResolver;

final class UserType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('name', TextType::class)
            ->add('email', EmailType::class)
            ->add('password', PasswordType::class);
    }
    
    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults([
            'data_class' => User::class,
            'csrf_protection' => true,
        ]);
    }
}
```

## Twig Templates

```twig
{# Auto-escaping is ON by default #}
<h1>{{ user.name }}</h1>

{# Only use raw when content is trusted/sanitized #}
{{ trusted_html|raw }}

{# Translation #}
{{ 'user.welcome'|trans({'%name%': user.name}) }}

{# Routing #}
<a href="{{ path('user_show', {id: user.id}) }}">View</a>

{# CSRF in forms #}
{{ form_start(form) }}
    {{ form_widget(form) }}
    <button type="submit">Submit</button>
{{ form_end(form) }}
```

## Event Subscribers

```php
<?php

declare(strict_types=1);

namespace App\EventSubscriber;

use App\Event\UserCreatedEvent;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

final class UserEventSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            UserCreatedEvent::class => 'onUserCreated',
        ];
    }
    
    public function onUserCreated(UserCreatedEvent $event): void
    {
        // Send welcome email, etc.
    }
}
```

## Messenger (Async)

```php
// Message
final readonly class SendEmailMessage
{
    public function __construct(
        public string $recipient,
        public string $subject,
        public string $content
    ) {}
}

// Handler
#[AsMessageHandler]
final class SendEmailHandler
{
    public function __invoke(SendEmailMessage $message): void
    {
        // Send email
    }
}

// Dispatch
$this->message_bus->dispatch(new SendEmailMessage($email, $subject, $content));
```

## Performance Tips
- Use `->select()` in DQL for partial objects
- Use `fetch="EXTRA_LAZY"` for large collections
- Enable query result cache
- Use Messenger for slow operations
- Profile with Symfony Profiler
