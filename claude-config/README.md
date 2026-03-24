# Connecting OpenFunction to Claude Desktop

Once your MCP server is working (test with `npm run test-tools` first), you can connect it to Claude Desktop so Claude can use your tools in conversation.

## Step 1: Find your config file

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Step 2: Add your server

Open the config file and add your server to the `mcpServers` object:

```json
{
  "mcpServers": {
    "openfunction": {
      "command": "npx",
      "args": ["tsx", "/FULL/PATH/TO/openFunctions/src/index.ts"]
    }
  }
}
```

Replace `/FULL/PATH/TO/openFunctions` with the actual path to your cloned repo.

## Step 3: Restart Claude Desktop

Quit and reopen Claude Desktop. You should see your tools available in the tools menu (hammer icon).

## Step 4: Test it

Try asking Claude:
- "Create a study task for reading chapter 5 of Biology"
- "What tasks do I have?"
- "Save a bookmark for https://modelcontextprotocol.io"

## Troubleshooting

If the tools don't appear:

1. Check the path in your config is correct (use absolute path)
2. Make sure `npm install` has been run in the repo
3. Check Claude Desktop's logs for errors
4. Try running `npm start` manually to see if the server starts

## Alternative: Use the MCP Inspector

You can also test your server with the official MCP inspector:

```bash
npm run inspect
```

This opens a web UI where you can see your tools and call them interactively.
