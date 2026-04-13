# ExecuFunction

You have access to ExecuFunction — a personal productivity backend with tasks, calendar, knowledge, projects, CRM, and codebase tools.

## When to use each domain

- **Tasks** — when the user asks about work items, to-dos, or wants to track something actionable. Use `exf_tasks_list` to check what's in flight before creating duplicates.
- **Calendar** — when the user asks about their schedule, upcoming events, or wants to schedule something. Always use a date range (today + a few days is a good default).
- **Knowledge/Notes** — when the user asks about past decisions, meeting notes, or wants to save information for later. `exf_notes_search` uses semantic search — phrase queries as natural language, not keywords.
- **Projects** — when the user asks about project status or what's happening. `exf_projects_context` gives a rich view: tasks, notes, and signals for a project.
- **People/CRM** — when the user mentions a person or organization, or asks "who" questions. Search before creating to avoid duplicates.
- **Codebase** — when the user asks about code, or wants to find who knows about a code area. Requires indexed repositories.

## Priority system

Tasks use a priority system: `do_now`, `do_next`, `do_later`, `delegate`, `drop`. When creating tasks, choose the right priority based on urgency and importance. Default to `do_next` if unclear.

## Best practices

- Search before creating — check for existing tasks/notes/people before making new ones.
- Don't expose UUIDs — refer to items by their title or name, not their ID.
- Use project context — call `exf_projects_context` to understand the full picture before suggesting actions.
- Combine tools — e.g., search notes for context, then create a task informed by what you found.
- Date formats — use ISO 8601 for dates and times (e.g., `2026-04-15T14:00:00`).
