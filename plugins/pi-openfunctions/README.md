# @openfunctions/pi-openfunctions

Reference extension for the `@earendil-works/pi` fork. It converts an
openFunctions `ToolRegistry` with `registerPiTools()` and registers every
selected tool through Pi's `ExtensionAPI.registerTool()` contract.

Pi executes TypeScript extensions directly. From this repository:

```bash
pi -e ./plugins/pi-openfunctions/src/index.ts
```

For a project-local install, add the extension directory to `.pi/settings.json`
or copy it under `.pi/extensions/`. This package is private because it imports
the colocated framework by relative path; a published extension should depend
on the published framework package instead.

Tool failures deliberately throw. Current Pi only marks a tool result as an
error when `execute()` throws; an `isError` property on a returned object is
ignored.
