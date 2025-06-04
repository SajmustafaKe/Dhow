## Add tools to agents
In Rowboat, you can add tools to your agents by (a) selecting from a in-built library of MCP tools (b) adding your own customer MCP servers (c) integrating your APIs through a webhook (e) mocking tool calls to test the system.

### Adding MCP tools

#### Hosted MCP Library

Rowboat has partnered with ![Kavis AI](https://www.klavis.ai/) to provide a growing library of hosted MCP servers. You can obtain a Klavis API key and set it using:
```bash
export KLAVIS_API_KEY=your-klavis-api-key
```

![Library](img/mcp-library.png)

Enable any of the hosted MCP servers by clicking on the enable button. The server will take approximately 10 seconds to spin up.

![Library](img/enable-mcp-server.png)

For most servers, you will need to authorize it by clicking on the 'Auth' button and connecting to your account e.g. connecting to you github or slack account

The servers you have enabled will show up under tools section in the build view and can be added to any of the agents.

![Library](img/mcp-tools-build-view.png)

Note: For GSuite tools, you need to get a Google Client ID and set it using:
```bash
export KLAVIS_GOOGLE_CLIENT_ID=your-google-client-id
```

To obtain a Google Client ID:
1. Go to the [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Go to "APIs & Services" → "OAuth consent screen" and complete the setup
4. Go to "APIs & Services" → "Credentials" → "OAuth client ID" and create credentials for web application.

#### Custom MCP Server
You can add any running MCP server in Settings -> Tools.

![Example Tool](img/add-mcp-server.png)

You can use [supergateway](https://github.com/supercorp-ai/supergateway) to expose any MCP stdio server as an SSE server.

Now, you can import the tools from the MCP server in the Build view.

![Example Tool](img/import-mcp-tools.png)

### Adding mock tools
You can mock any tool you have created by checking the 'Mock tool responses' option.


![Example Tool](img/mock-tool.png)

### Debug tool calls in the playground
When agents call tools during a chat in the playground, the tool call parameters and response are available for debugging real-time. For testing purposes, the platform can produce mock tool responses in the playground, without integrating actual tools.

![Mock Tool Responses](img/mock-response.png)