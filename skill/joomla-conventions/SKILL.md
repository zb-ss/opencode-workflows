---
name: joomla-conventions
description: Joomla 4/5 component development with MVC, services, plugins, and language handling
license: MIT
compatibility: opencode
metadata:
  cms: joomla
  version: "4.0+"
---

## Component Structure (Joomla 4/5)

```
com_example/
├── administrator/
│   ├── forms/
│   │   └── item.xml
│   ├── services/
│   │   └── provider.php
│   ├── src/
│   │   ├── Controller/
│   │   ├── Extension/
│   │   ├── Field/
│   │   ├── Helper/
│   │   ├── Model/
│   │   ├── Service/
│   │   ├── Table/
│   │   └── View/
│   └── tmpl/
│       └── items/
├── site/
│   ├── src/
│   └── tmpl/
├── media/
│   ├── css/
│   └── js/
└── language/
    └── en-GB/
```

## Service Provider

```php
<?php

declare(strict_types=1);

namespace Joomla\Component\Example\Administrator\Extension;

use Joomla\CMS\Extension\ComponentInterface;
use Joomla\CMS\Extension\Service\Provider\ComponentDispatcherFactory;
use Joomla\CMS\Extension\Service\Provider\MVCFactory;
use Joomla\CMS\MVC\Factory\MVCFactoryInterface;
use Joomla\DI\Container;
use Joomla\DI\ServiceProviderInterface;

return new class implements ServiceProviderInterface
{
    public function register(Container $container): void
    {
        $container->registerServiceProvider(new MVCFactory('\\Joomla\\Component\\Example'));
        $container->registerServiceProvider(new ComponentDispatcherFactory('\\Joomla\\Component\\Example'));
        
        $container->set(
            ComponentInterface::class,
            function (Container $container) {
                $component = new ExampleComponent($container->get(ComponentDispatcherFactoryInterface::class));
                $component->setMVCFactory($container->get(MVCFactoryInterface::class));
                return $component;
            }
        );
    }
};
```

## Model (ListModel)

```php
<?php

declare(strict_types=1);

namespace Joomla\Component\Example\Administrator\Model;

use Joomla\CMS\MVC\Model\ListModel;
use Joomla\Database\QueryInterface;

class ItemsModel extends ListModel
{
    protected function getListQuery(): QueryInterface
    {
        $db = $this->getDatabase();
        $query = $db->getQuery(true);
        
        $query->select($db->quoteName(['a.id', 'a.title', 'a.state']))
            ->from($db->quoteName('#__example_items', 'a'));
        
        // Filter by state
        $state = $this->getState('filter.state');
        if (is_numeric($state)) {
            $query->where($db->quoteName('a.state') . ' = :state')
                ->bind(':state', $state, ParameterType::INTEGER);
        }
        
        return $query;
    }
}
```

## Table Class

```php
<?php

declare(strict_types=1);

namespace Joomla\Component\Example\Administrator\Table;

use Joomla\CMS\Table\Table;
use Joomla\Database\DatabaseDriver;

class ItemTable extends Table
{
    public function __construct(DatabaseDriver $db)
    {
        parent::__construct('#__example_items', 'id', $db);
    }
    
    public function check(): bool
    {
        if (empty($this->title)) {
            $this->setError(Text::_('COM_EXAMPLE_ERROR_TITLE_REQUIRED'));
            return false;
        }
        
        return true;
    }
}
```

## Security - Database Queries

```php
// ALWAYS use parameter binding
$query->where($db->quoteName('id') . ' = :id')
    ->bind(':id', $id, ParameterType::INTEGER);

// For strings
$query->where($db->quoteName('alias') . ' = :alias')
    ->bind(':alias', $alias, ParameterType::STRING);

// NEVER do this:
// $query->where('id = ' . $id); // SQL INJECTION!
```

## Language Strings

```php
// In PHP
use Joomla\CMS\Language\Text;

echo Text::_('COM_EXAMPLE_TITLE');
echo Text::sprintf('COM_EXAMPLE_ITEMS_COUNT', $count);
echo Text::plural('COM_EXAMPLE_N_ITEMS_DELETED', $count);

// In templates
<?php echo Text::_('COM_EXAMPLE_SUBMIT'); ?>
```

Language file (`language/en-GB/com_example.ini`):
```ini
COM_EXAMPLE_TITLE="Example Component"
COM_EXAMPLE_ITEMS_COUNT="Found %d items"
COM_EXAMPLE_N_ITEMS_DELETED="1 item deleted"
COM_EXAMPLE_N_ITEMS_DELETED_1="1 item deleted"
COM_EXAMPLE_N_ITEMS_DELETED_MORE="%d items deleted"
```

## Forms (XML)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<form>
    <fieldset name="details">
        <field
            name="title"
            type="text"
            label="COM_EXAMPLE_FIELD_TITLE_LABEL"
            required="true"
            maxlength="255"
        />
        <field
            name="state"
            type="list"
            label="JSTATUS"
            default="1"
        >
            <option value="1">JPUBLISHED</option>
            <option value="0">JUNPUBLISHED</option>
        </field>
    </fieldset>
</form>
```

## Plugin Structure

```php
<?php

declare(strict_types=1);

namespace Joomla\Plugin\System\Example\Extension;

use Joomla\CMS\Plugin\CMSPlugin;
use Joomla\Event\SubscriberInterface;

final class Example extends CMSPlugin implements SubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'onAfterInitialise' => 'onAfterInitialise',
        ];
    }
    
    public function onAfterInitialise(): void
    {
        // Plugin logic here
    }
}
```

## Permission Checks

```php
use Joomla\CMS\Factory;

$user = Factory::getApplication()->getIdentity();

if (!$user->authorise('core.edit', 'com_example')) {
    throw new \Exception(Text::_('JERROR_ALERTNOAUTHOR'), 403);
}
```

## CSRF Token

```php
// In form
<?php echo HTMLHelper::_('form.token'); ?>

// In controller
if (!Session::checkToken()) {
    throw new \Exception(Text::_('JINVALID_TOKEN'), 403);
}
```
