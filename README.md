# Somewhere MCP

**Build, deploy, and inspect apps from your AI assistant.**

[Somewhere](https://somewhere.tech) provides the backend for AI-built apps: declared data, authentication, files, email, payments, and hosted functions. This repository contains the production MCP server source that connects an assistant to those services.

An assistant can read the platform contract, deploy raw application source, inspect logs, verify the app in a browser, and manage project tasks through the same connection.

## Connect

Use a hosted endpoint. You do not need to clone or deploy this repository to use Somewhere.

| Client | Server URL |
| --- | --- |
| Claude connector | `https://mcp.somewhere.tech/mcp/connector` |
| ChatGPT connector | `https://mcp.somewhere.tech/mcp/chatgpt` |
| Cursor and other remote MCP clients | `https://mcp.somewhere.tech/mcp` |

These are profiles of **one implementation**, with tool visibility configured for each surface. They share the same platform account and projects. Configuring a custom connector is separate from a client's directory listing or approval.

### Cursor

The Cursor Marketplace submission is being prepared. It is not listed or approved yet. Until it is available, add this configuration to `~/.cursor/mcp.json` for your account or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "somewhere": {
      "url": "https://mcp.somewhere.tech/mcp"
    }
  }
}
```

Reload Cursor, enable the `somewhere` server in **Customize**, and sign in through OAuth when prompted. A Somewhere account is required. The connection uses Streamable HTTP and your account's existing project permissions. This configuration follows Cursor's documented remote-server format, but end-to-end Cursor OAuth acceptance has not yet been verified. Cursor applies its normal MCP tool approval settings; this package includes no hooks and does not enable automatic approvals.

The repository also contains `.cursor-plugin/plugin.json` and the same root `mcp.json` for local plugin testing and Marketplace review.

### Other MCP clients

Sign in through the client's OAuth flow when prompted. Clients that use API keys can add an `Authorization: Bearer <your Somewhere API key>` header in their local configuration.

Then ask your assistant:

> Build a small idea board on Somewhere. Read the getting-started documentation, deploy it, and verify the live page in a browser. Give me the URL and tell me what you checked.

The `docs` tool supplies platform reference material; `catalog` lists the tools available on your connection. Use `advisor` for platform-specific questions. Tool calls remain subject to account permissions and the client's approval settings.

Prefer a terminal workflow? The [Somewhere CLI](https://github.com/Somewhere-Tech/somewhere-cli) is another route to the same platform. App code can use the [TypeScript SDK](https://github.com/Somewhere-Tech/somewhere-sdk-js); agents should start with the current [build guide](https://somewhere.tech/start.txt).

## Verify the source

```sh
npm ci
npm run typecheck
npm test
npm run check:bundle
```

The checks run locally without deploying an app or calling paid AI models. `source-manifest.json` records the canonical source commit and a SHA-256 hash for every exported file. The selected runtime files are copied byte-for-byte from the platform source; the example configuration and package scripts are adapted for this distribution.

## Contribute

Issues and pull requests are welcome. For a bug, include the MCP client/version, endpoint profile, tool name, and a minimal reproduction. Remove credentials and private app data.

This repository is maintained through a reproducible export from the platform's canonical source. Maintainers integrate accepted changes there before publishing the next snapshot, so the public server and hosted implementation do not develop separately. The private platform history is not included in the export.

The command-line client is [`@somewhere-tech/cli`](https://www.npmjs.com/package/@somewhere-tech/cli), and the optional JavaScript and TypeScript SDK is [`@somewhere-tech/sdk`](https://www.npmjs.com/package/@somewhere-tech/sdk).

## Deployment scope

The MCP server is open source, but it is a bridge to somewhere.tech services. A separate deployment requires private API and runner service bindings that are not part of this repository. `wrangler.example.toml` contains placeholders only and does not make the full somewhere.tech platform self-hostable.

## License

MIT
