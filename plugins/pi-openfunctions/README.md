# @openfunctions/pi-openfunctions

Reference extension for the `@earendil-works/pi` fork. It converts an
openFunctions `ToolRegistry` with `toPiTools()` and registers every
selected tool through Pi's `ExtensionAPI.registerTool()` contract.

Pi executes TypeScript extensions directly. From this repository:

```bash
pi -e ./plugins/pi-openfunctions/src/index.ts
```

For a project-local install, add the extension directory to `.pi/settings.json`
or copy it under `.pi/extensions/`. This private reference imports the packaged `openfunction/framework/pi`, registry
and tool subpaths. Its development dependency links the built package; standalone
consumers install `openfunction` alongside the extension.

Tool failures deliberately throw. Current Pi only marks a tool result as an
error when `execute()` throws; an `isError` property on a returned object is
ignored.
