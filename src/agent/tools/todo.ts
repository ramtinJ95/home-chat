import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { MAX_LIST_TITLE, MAX_TODO_TEXT } from '../../todos.ts';

// Todo lists live on the server (src/todos.ts), so the tool only forwards the call. Deleting or unsharing a list is
// left to the Todos page.
export const description = 'Read and change the user\'s todo lists: their own private lists and the ones shared with the household. '
  + 'List them, show one, make a new one, add items, tick items off, put them back or remove them.';

export const parameters = Type.Object({
  action: StringEnum(['lists', 'show', 'create', 'add', 'complete', 'reopen', 'remove'] as const),
  list: Type.Optional(Type.String({description: 'The list, by its id or its exact name, for every action but lists and create'})),
  title: Type.Optional(Type.String({maxLength: MAX_LIST_TITLE, description: 'The new list\'s name, for create'})),
  shared: Type.Optional(Type.Boolean({description: 'For create: share the list with the household, e.g. groceries. Private by default'})),
  items: Type.Optional(Type.Array(Type.Union([Type.String({maxLength: MAX_TODO_TEXT}), Type.Integer({minimum: 1})]), {maxItems: 30,
    description: 'For add: the texts of the new items. For complete, reopen and remove: the item numbers, from show'})),
});
