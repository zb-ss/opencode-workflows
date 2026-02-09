---
name: joomla3-legacy
description: Joomla 3.x legacy patterns with JFactory, non-namespaced MVC, JDatabase, and plugin structure
license: MIT
compatibility: opencode
metadata:
  cms: joomla
  version: "3.x"
---

## Component Structure (Joomla 3)

```
com_example/
├── administrator/
│   ├── controllers/
│   │   ├── example.php        # JControllerForm
│   │   └── items.php          # JControllerAdmin
│   ├── helpers/
│   │   └── example.php
│   ├── models/
│   │   ├── fields/            # Custom form fields
│   │   ├── forms/
│   │   │   └── item.xml
│   │   ├── item.php           # JModelAdmin
│   │   └── items.php          # JModelList
│   ├── sql/
│   │   ├── install.mysql.utf8.sql
│   │   └── uninstall.mysql.utf8.sql
│   ├── tables/
│   │   └── item.php           # JTable
│   ├── views/
│   │   ├── item/
│   │   │   ├── tmpl/
│   │   │   │   └── edit.php
│   │   │   └── view.html.php  # JViewLegacy
│   │   └── items/
│   │       ├── tmpl/
│   │       │   └── default.php
│   │       └── view.html.php
│   ├── controller.php         # Main JControllerLegacy
│   └── example.php            # Entry point
├── site/
│   ├── controllers/
│   ├── models/
│   ├── views/
│   ├── controller.php
│   └── example.php
├── media/
│   ├── css/
│   └── js/
└── language/
    └── en-GB/
        ├── en-GB.com_example.ini
        └── en-GB.com_example.sys.ini
```

---

## Entry Point

```php
<?php
// administrator/components/com_example/example.php

// No direct access
defined('_JEXEC') or die;

// Access check
if (!JFactory::getUser()->authorise('core.manage', 'com_example')) {
    throw new Exception(JText::_('JERROR_ALERTNOAUTHOR'), 403);
}

// Include helper
JLoader::register('ExampleHelper', JPATH_COMPONENT . '/helpers/example.php');

// Get controller
$controller = JControllerLegacy::getInstance('Example');

// Execute task
$controller->execute(JFactory::getApplication()->input->get('task'));

// Redirect
$controller->redirect();
```

---

## Controllers

### Main Controller
```php
<?php
// administrator/components/com_example/controller.php

defined('_JEXEC') or die;

class ExampleController extends JControllerLegacy
{
    protected $default_view = 'items';
    
    public function display($cachable = false, $urlparams = array())
    {
        $view = $this->input->get('view', 'items');
        $layout = $this->input->get('layout', 'default');
        $id = $this->input->getInt('id');
        
        // Check edit form
        if ($view === 'item' && $layout === 'edit' && !$this->checkEditId('com_example.edit.item', $id)) {
            $this->setError(JText::sprintf('JLIB_APPLICATION_ERROR_UNHELD_ID', $id));
            $this->setMessage($this->getError(), 'error');
            $this->setRedirect(JRoute::_('index.php?option=com_example&view=items', false));
            return false;
        }
        
        parent::display($cachable, $urlparams);
        
        return $this;
    }
}
```

### Admin Controller (for single item CRUD)
```php
<?php
// administrator/components/com_example/controllers/item.php

defined('_JEXEC') or die;

class ExampleControllerItem extends JControllerForm
{
    // JControllerForm handles add, edit, save, cancel, batch automatically
    
    protected function allowAdd($data = array())
    {
        return JFactory::getUser()->authorise('core.create', 'com_example');
    }
    
    protected function allowEdit($data = array(), $key = 'id')
    {
        $id = isset($data[$key]) ? $data[$key] : 0;
        $user = JFactory::getUser();
        
        return $user->authorise('core.edit', 'com_example.item.' . $id)
            || ($user->authorise('core.edit.own', 'com_example.item.' . $id)
                && $data['created_by'] == $user->id);
    }
}
```

### List Controller (for bulk actions)
```php
<?php
// administrator/components/com_example/controllers/items.php

defined('_JEXEC') or die;

class ExampleControllerItems extends JControllerAdmin
{
    public function getModel($name = 'Item', $prefix = 'ExampleModel', $config = array('ignore_request' => true))
    {
        return parent::getModel($name, $prefix, $config);
    }
}
```

---

## Models

### List Model
```php
<?php
// administrator/components/com_example/models/items.php

defined('_JEXEC') or die;

JLoader::register('ExampleHelper', JPATH_COMPONENT . '/helpers/example.php');

class ExampleModelItems extends JModelList
{
    public function __construct($config = array())
    {
        if (empty($config['filter_fields'])) {
            $config['filter_fields'] = array(
                'id', 'a.id',
                'title', 'a.title',
                'state', 'a.state',
                'ordering', 'a.ordering',
            );
        }
        
        parent::__construct($config);
    }
    
    protected function populateState($ordering = 'a.ordering', $direction = 'ASC')
    {
        $app = JFactory::getApplication();
        
        // Filter: search
        $search = $this->getUserStateFromRequest($this->context . '.filter.search', 'filter_search', '', 'string');
        $this->setState('filter.search', $search);
        
        // Filter: state
        $state = $this->getUserStateFromRequest($this->context . '.filter.state', 'filter_state', '', 'string');
        $this->setState('filter.state', $state);
        
        parent::populateState($ordering, $direction);
    }
    
    protected function getListQuery()
    {
        $db = $this->getDbo();
        $query = $db->getQuery(true);
        
        $query->select('a.*')
            ->from($db->quoteName('#__example_items', 'a'));
        
        // Filter: state
        $state = $this->getState('filter.state');
        if (is_numeric($state)) {
            $query->where($db->quoteName('a.state') . ' = ' . (int) $state);
        }
        
        // Filter: search
        $search = $this->getState('filter.search');
        if (!empty($search)) {
            $search = $db->quote('%' . $db->escape($search, true) . '%');
            $query->where($db->quoteName('a.title') . ' LIKE ' . $search);
        }
        
        // Ordering
        $orderCol = $this->state->get('list.ordering', 'a.ordering');
        $orderDir = $this->state->get('list.direction', 'ASC');
        $query->order($db->escape($orderCol) . ' ' . $db->escape($orderDir));
        
        return $query;
    }
}
```

### Admin Model (single item)
```php
<?php
// administrator/components/com_example/models/item.php

defined('_JEXEC') or die;

class ExampleModelItem extends JModelAdmin
{
    protected $text_prefix = 'COM_EXAMPLE';
    
    public function getTable($type = 'Item', $prefix = 'ExampleTable', $config = array())
    {
        return JTable::getInstance($type, $prefix, $config);
    }
    
    public function getForm($data = array(), $loadData = true)
    {
        $form = $this->loadForm(
            'com_example.item',
            'item',
            array('control' => 'jform', 'load_data' => $loadData)
        );
        
        if (empty($form)) {
            return false;
        }
        
        return $form;
    }
    
    protected function loadFormData()
    {
        $data = JFactory::getApplication()->getUserState('com_example.edit.item.data', array());
        
        if (empty($data)) {
            $data = $this->getItem();
        }
        
        return $data;
    }
    
    protected function prepareTable($table)
    {
        $date = JFactory::getDate();
        $user = JFactory::getUser();
        
        if (empty($table->id)) {
            // New item
            $table->created = $date->toSql();
            $table->created_by = $user->id;
            
            // Ordering
            if (empty($table->ordering)) {
                $db = $this->getDbo();
                $query = $db->getQuery(true)
                    ->select('MAX(ordering)')
                    ->from($db->quoteName('#__example_items'));
                $db->setQuery($query);
                $table->ordering = (int) $db->loadResult() + 1;
            }
        } else {
            // Existing item
            $table->modified = $date->toSql();
            $table->modified_by = $user->id;
        }
    }
}
```

---

## Table Class

```php
<?php
// administrator/components/com_example/tables/item.php

defined('_JEXEC') or die;

class ExampleTableItem extends JTable
{
    public function __construct(&$db)
    {
        parent::__construct('#__example_items', 'id', $db);
        
        // Enable asset tracking (for permissions)
        $this->setColumnAlias('published', 'state');
    }
    
    public function bind($array, $ignore = '')
    {
        // Handle params as JSON
        if (isset($array['params']) && is_array($array['params'])) {
            $registry = new JRegistry($array['params']);
            $array['params'] = (string) $registry;
        }
        
        return parent::bind($array, $ignore);
    }
    
    public function check()
    {
        // Validate title
        if (trim($this->title) === '') {
            $this->setError(JText::_('COM_EXAMPLE_ERROR_TITLE_REQUIRED'));
            return false;
        }
        
        // Generate alias
        if (empty($this->alias)) {
            $this->alias = $this->title;
        }
        $this->alias = JFilterOutput::stringURLSafe($this->alias);
        
        return true;
    }
    
    public function store($updateNulls = false)
    {
        $date = JFactory::getDate();
        $user = JFactory::getUser();
        
        if ($this->id) {
            $this->modified = $date->toSql();
            $this->modified_by = $user->id;
        } else {
            if (!(int) $this->created) {
                $this->created = $date->toSql();
            }
            if (empty($this->created_by)) {
                $this->created_by = $user->id;
            }
        }
        
        return parent::store($updateNulls);
    }
}
```

---

## Views

### List View
```php
<?php
// administrator/components/com_example/views/items/view.html.php

defined('_JEXEC') or die;

class ExampleViewItems extends JViewLegacy
{
    protected $items;
    protected $pagination;
    protected $state;
    protected $filterForm;
    protected $activeFilters;
    
    public function display($tpl = null)
    {
        $this->items = $this->get('Items');
        $this->pagination = $this->get('Pagination');
        $this->state = $this->get('State');
        $this->filterForm = $this->get('FilterForm');
        $this->activeFilters = $this->get('ActiveFilters');
        
        // Check for errors
        if (count($errors = $this->get('Errors'))) {
            throw new Exception(implode("\n", $errors), 500);
        }
        
        $this->addToolbar();
        
        parent::display($tpl);
    }
    
    protected function addToolbar()
    {
        $user = JFactory::getUser();
        
        JToolbarHelper::title(JText::_('COM_EXAMPLE_ITEMS_TITLE'), 'list');
        
        if ($user->authorise('core.create', 'com_example')) {
            JToolbarHelper::addNew('item.add');
        }
        
        if ($user->authorise('core.edit', 'com_example') || $user->authorise('core.edit.own', 'com_example')) {
            JToolbarHelper::editList('item.edit');
        }
        
        if ($user->authorise('core.edit.state', 'com_example')) {
            JToolbarHelper::publish('items.publish', 'JTOOLBAR_PUBLISH', true);
            JToolbarHelper::unpublish('items.unpublish', 'JTOOLBAR_UNPUBLISH', true);
        }
        
        if ($user->authorise('core.delete', 'com_example')) {
            JToolbarHelper::deleteList('JGLOBAL_CONFIRM_DELETE', 'items.delete');
        }
        
        if ($user->authorise('core.admin', 'com_example')) {
            JToolbarHelper::preferences('com_example');
        }
    }
}
```

### List View Template
```php
<?php
// administrator/components/com_example/views/items/tmpl/default.php

defined('_JEXEC') or die;

JHtml::_('bootstrap.tooltip');
JHtml::_('behavior.multiselect');
JHtml::_('formbehavior.chosen', 'select');

$user = JFactory::getUser();
$listOrder = $this->escape($this->state->get('list.ordering'));
$listDirn = $this->escape($this->state->get('list.direction'));
$saveOrder = $listOrder === 'a.ordering';

if ($saveOrder) {
    $saveOrderingUrl = 'index.php?option=com_example&task=items.saveOrderAjax&tmpl=component';
    JHtml::_('sortablelist.sortable', 'itemList', 'adminForm', strtolower($listDirn), $saveOrderingUrl);
}
?>
<form action="<?php echo JRoute::_('index.php?option=com_example&view=items'); ?>" method="post" name="adminForm" id="adminForm">
    <div id="j-sidebar-container" class="span2">
        <?php echo JHtmlSidebar::render(); ?>
    </div>
    <div id="j-main-container" class="span10">
        <?php echo JLayoutHelper::render('joomla.searchtools.default', array('view' => $this)); ?>
        
        <?php if (empty($this->items)) : ?>
            <div class="alert alert-no-items">
                <?php echo JText::_('JGLOBAL_NO_MATCHING_RESULTS'); ?>
            </div>
        <?php else : ?>
            <table class="table table-striped" id="itemList">
                <thead>
                    <tr>
                        <th width="1%" class="nowrap center hidden-phone">
                            <?php echo JHtml::_('searchtools.sort', '', 'a.ordering', $listDirn, $listOrder, null, 'asc', 'JGRID_HEADING_ORDERING', 'icon-menu-2'); ?>
                        </th>
                        <th width="1%" class="center">
                            <?php echo JHtml::_('grid.checkall'); ?>
                        </th>
                        <th width="1%" class="nowrap center">
                            <?php echo JHtml::_('searchtools.sort', 'JSTATUS', 'a.state', $listDirn, $listOrder); ?>
                        </th>
                        <th>
                            <?php echo JHtml::_('searchtools.sort', 'JGLOBAL_TITLE', 'a.title', $listDirn, $listOrder); ?>
                        </th>
                        <th width="1%" class="nowrap center hidden-phone">
                            <?php echo JHtml::_('searchtools.sort', 'JGRID_HEADING_ID', 'a.id', $listDirn, $listOrder); ?>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($this->items as $i => $item) :
                        $canEdit = $user->authorise('core.edit', 'com_example.item.' . $item->id);
                        $canChange = $user->authorise('core.edit.state', 'com_example.item.' . $item->id);
                    ?>
                    <tr class="row<?php echo $i % 2; ?>">
                        <td class="order nowrap center hidden-phone">
                            <?php
                            $iconClass = '';
                            if (!$canChange) {
                                $iconClass = ' inactive';
                            } elseif (!$saveOrder) {
                                $iconClass = ' inactive tip-top hasTooltip" title="' . JHtml::_('tooltipText', 'JORDERINGDISABLED');
                            }
                            ?>
                            <span class="sortable-handler<?php echo $iconClass; ?>">
                                <span class="icon-menu" aria-hidden="true"></span>
                            </span>
                            <input type="text" style="display:none" name="order[]" size="5" value="<?php echo $item->ordering; ?>" class="width-20 text-area-order" />
                        </td>
                        <td class="center">
                            <?php echo JHtml::_('grid.id', $i, $item->id); ?>
                        </td>
                        <td class="center">
                            <?php echo JHtml::_('jgrid.published', $item->state, $i, 'items.', $canChange); ?>
                        </td>
                        <td>
                            <?php if ($canEdit) : ?>
                                <a href="<?php echo JRoute::_('index.php?option=com_example&task=item.edit&id=' . $item->id); ?>">
                                    <?php echo $this->escape($item->title); ?>
                                </a>
                            <?php else : ?>
                                <?php echo $this->escape($item->title); ?>
                            <?php endif; ?>
                        </td>
                        <td class="center hidden-phone">
                            <?php echo (int) $item->id; ?>
                        </td>
                    </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
            <?php echo $this->pagination->getListFooter(); ?>
        <?php endif; ?>
    </div>
    
    <input type="hidden" name="task" value="" />
    <input type="hidden" name="boxchecked" value="0" />
    <?php echo JHtml::_('form.token'); ?>
</form>
```

---

## JFactory Static Calls

```php
// Application
$app = JFactory::getApplication();
$app->enqueueMessage(JText::_('COM_EXAMPLE_MESSAGE_SUCCESS'), 'success');
$app->redirect(JRoute::_('index.php?option=com_example', false));

// Input
$input = JFactory::getApplication()->input;
$id = $input->getInt('id', 0);
$task = $input->get('task', '', 'cmd');
$data = $input->get('jform', array(), 'array');

// Database
$db = JFactory::getDbo();
$query = $db->getQuery(true);

// User
$user = JFactory::getUser();
$userId = $user->id;
$isGuest = $user->guest;

// Session
$session = JFactory::getSession();
$session->set('my_value', $value);
$value = $session->get('my_value', 'default');

// Document
$doc = JFactory::getDocument();
$doc->addStyleSheet(JUri::root() . 'media/com_example/css/style.css');
$doc->addScript(JUri::root() . 'media/com_example/js/script.js');

// Language
$lang = JFactory::getLanguage();
$lang->load('com_example', JPATH_ADMINISTRATOR);

// Date
$date = JFactory::getDate();
$now = $date->toSql();
```

---

## Database Queries

```php
$db = JFactory::getDbo();
$query = $db->getQuery(true);

// SELECT
$query->select($db->quoteName(array('id', 'title', 'state')))
    ->from($db->quoteName('#__example_items'))
    ->where($db->quoteName('state') . ' = 1')
    ->where($db->quoteName('catid') . ' = ' . (int) $catid)
    ->order($db->quoteName('ordering') . ' ASC');

$db->setQuery($query);

// Single value
$result = $db->loadResult();

// Single row as object
$row = $db->loadObject();

// Single row as array
$row = $db->loadAssoc();

// All rows as objects
$rows = $db->loadObjectList();

// All rows keyed by column
$rows = $db->loadObjectList('id');

// Single column
$ids = $db->loadColumn();

// INSERT
$query->clear()
    ->insert($db->quoteName('#__example_items'))
    ->columns($db->quoteName(array('title', 'state', 'created')))
    ->values($db->quote($title) . ', 1, ' . $db->quote(JFactory::getDate()->toSql()));

$db->setQuery($query);
$db->execute();
$newId = $db->insertid();

// UPDATE
$query->clear()
    ->update($db->quoteName('#__example_items'))
    ->set($db->quoteName('title') . ' = ' . $db->quote($title))
    ->set($db->quoteName('state') . ' = 0')
    ->where($db->quoteName('id') . ' = ' . (int) $id);

$db->setQuery($query);
$db->execute();

// DELETE
$query->clear()
    ->delete($db->quoteName('#__example_items'))
    ->where($db->quoteName('id') . ' = ' . (int) $id);

$db->setQuery($query);
$db->execute();
```

---

## Plugins (Joomla 3)

```php
<?php
// plugins/system/example/example.php

defined('_JEXEC') or die;

class PlgSystemExample extends JPlugin
{
    /**
     * Load language automatically
     */
    protected $autoloadLanguage = true;
    
    /**
     * Application object
     */
    protected $app;
    
    /**
     * Database object
     */
    protected $db;
    
    public function onAfterInitialise()
    {
        // Runs after Joomla initializes
    }
    
    public function onAfterRoute()
    {
        // Runs after routing
        $option = $this->app->input->get('option');
        $view = $this->app->input->get('view');
    }
    
    public function onContentPrepare($context, &$article, &$params, $page = 0)
    {
        // Modify content before display
        if ($context !== 'com_content.article') {
            return;
        }
        
        $article->text = str_replace('{example}', 'Replacement', $article->text);
    }
    
    public function onUserAfterSave($user, $isNew, $success, $msg)
    {
        if (!$success) {
            return;
        }
        
        if ($isNew) {
            // New user created
        }
    }
}
```

### Plugin XML
```xml
<?xml version="1.0" encoding="utf-8"?>
<extension type="plugin" group="system" method="upgrade">
    <name>plg_system_example</name>
    <version>1.0.0</version>
    <author>Your Name</author>
    <creationDate>2024-01</creationDate>
    <description>PLG_SYSTEM_EXAMPLE_DESC</description>
    
    <files>
        <filename plugin="example">example.php</filename>
    </files>
    
    <languages>
        <language tag="en-GB">language/en-GB/en-GB.plg_system_example.ini</language>
        <language tag="en-GB">language/en-GB/en-GB.plg_system_example.sys.ini</language>
    </languages>
    
    <config>
        <fields name="params">
            <fieldset name="basic">
                <field
                    name="enabled"
                    type="radio"
                    label="PLG_SYSTEM_EXAMPLE_ENABLED_LABEL"
                    default="1"
                    class="btn-group btn-group-yesno">
                    <option value="1">JYES</option>
                    <option value="0">JNO</option>
                </field>
            </fieldset>
        </fields>
    </config>
</extension>
```

---

## Security Patterns

```php
// CSRF Token check
JSession::checkToken() or jexit(JText::_('JINVALID_TOKEN'));

// In forms
<?php echo JHtml::_('form.token'); ?>

// Permission check
$user = JFactory::getUser();
if (!$user->authorise('core.edit', 'com_example')) {
    throw new Exception(JText::_('JERROR_ALERTNOAUTHOR'), 403);
}

// Input filtering
$input = JFactory::getApplication()->input;
$id = $input->getInt('id');           // Integer
$title = $input->getString('title');   // String (filtered)
$raw = $input->get('html', '', 'raw'); // Raw (dangerous!)
$cmd = $input->get('task', '', 'cmd'); // Command (alphanumeric + .-_)

// Database escaping - ALWAYS use quoteName and quote
$query->where($db->quoteName('id') . ' = ' . (int) $id);
$query->where($db->quoteName('title') . ' = ' . $db->quote($title));

// Output escaping in templates
<?php echo $this->escape($item->title); ?>
<?php echo htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); ?>
```

---

## Language Strings

```php
// Basic translation
echo JText::_('COM_EXAMPLE_TITLE');

// With sprintf replacement
echo JText::sprintf('COM_EXAMPLE_ITEMS_COUNT', $count);

// Plural forms
echo JText::plural('COM_EXAMPLE_N_ITEMS_DELETED', $count);

// JavaScript strings
JText::script('COM_EXAMPLE_CONFIRM_DELETE');
// Then in JS: Joomla.JText._('COM_EXAMPLE_CONFIRM_DELETE')
```

---

## JHtml Helpers

```php
// Date formatting
echo JHtml::_('date', $item->created, JText::_('DATE_FORMAT_LC2'));

// Truncate text
echo JHtml::_('string.truncate', $item->description, 100);

// Boolean icons
echo JHtml::_('jgrid.published', $item->state, $i, 'items.');

// Select lists
echo JHtml::_('select.genericlist', $options, 'myfield', 'class="inputbox"', 'value', 'text', $selected);

// Tooltips
JHtml::_('bootstrap.tooltip');
echo '<span class="hasTooltip" title="' . JHtml::_('tooltipText', 'Title', 'Description') . '">Hover me</span>';
```

---

## Common Gotchas

1. **No namespaces** - Use `JLoader::register()` for custom classes
```php
JLoader::register('ExampleHelper', JPATH_COMPONENT . '/helpers/example.php');
```

2. **JFactory deprecation warnings** - Still works but generates notices in newer PHP

3. **jQuery conflicts** - Joomla 3 uses MooTools by default
```php
JHtml::_('jquery.framework');
```

4. **Different JInput methods** - Use specific type methods
```php
$input->getInt('id');      // Not $input->get('id', 0, 'int')
$input->getString('name');
$input->getCmd('task');
```

5. **Ordering** - Always escape in ORDER BY
```php
$query->order($db->escape($orderCol) . ' ' . $db->escape($orderDir));
```
