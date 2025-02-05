# Building Assistants in Studio
This is a guide to building your first assistant on RowBoat Studio, with examples.<br>

Prerequisite:

1. **Open Source Users:** Complete the [open-source installation steps](/oss_installation/) to set up RowBoat Studio.
2. **Hosted App Users:** Sign in to [https://app.rowboatlabs.com/](https://app.rowboatlabs.com/)

## Create the set of initial agents
Copilot can set up agents for you from scratch.

### Instruct copilot
First, tell it about the initial set of agents that make up your assistant.

![Create Initial Agents](img/copilot-create.png)

Using copilot to create your initial set of agents helps you leverage best practices in formatting agent instructions and connecting agents to each other as a graph, all of which have been baked into copilot.

### Inspect the agents
Once you apply changes, inspect the agents to see how copilot has built them. Specifically, note the Instructions, Examples and Connected Agents in each agent.

![Agent Config](img/agent-config.png)

Also notice that copilot would likely have created a "Hub" agent that is "connected" to other agents.

![Hub Agent Config](img/hub-config.png)

### Make changes if needed
Tweak the instructions and examples manually if needed.

![Edit Agent Manually](img/edit-agent-manually.png)

## Try an example chat in the playground

### Chat with the assistant

The playground is intended to test out the assistant as you build it. The User and Assistant messages represent the conversation that your end-user will have if your assistant is deployed in production. The playground also has debug elements which show the flow of control between different agents in your system, as well as which agent finally responded to the user.

![Try Chat](img/try-chat.png)

In the playground, you can also set initial context at start of chat, that will be passed to all agents. This is typically used for providing user identity information such as user ID, login email, etc.   
![Use System Message](img/sys-msg.png)

### Ask copilot questions
You can ask copilot clarifications about the chat, such as why the agents responded a certain way or why an agent was invoked.

![Copilot Clarifications](img/copilot-clarifications.png)

## Add tools to agents
Copilot can help you add tools to agents.

#### Instruct copilot to add tools
![Add Tool](img/add-tool.png)

![Example Tool](img/example-tool.png)

### Inspect tools and agents
Note how copilot not only creates the tool definitions for you, but also updates the relevant agent instructions to use the tool and connects the tool to the agent.

![Inspect Agent Tools](img/inspect-agent-tools.png)
![Inspect Agent Tool Connections](img/inspect-agent-tool-connections.png)

### Debug tool calls in the playground
When agents call tools during a chat in the playground, the tool call parameters and response are available for debugging real-time. For testing purposes, the platform can produce mock tool responses in the playground, without integrating actual tools.

![Mock Tool Responses](img/mock-tool-responses.png)
![Debug Tool Calls](img/debug-tool-calls.png)

## Update agent behavior

Copilot can help you update agent behavior. It is also aware of the current chat in the playground so you can make references to the current chat while instructing copilot to update agents.

![Update Agent Behavior](img/update-agent-with-copilot.png)

Playground:
![Test Updated Agent](img/test-updated-agent.png)

## Simulate real-world user scenarios
Create a test-bench of real-world scenarios in the simulator.
![Scenarios](img/scenarios.png)

Run the scenarios as simulated chats betweeen a user (role-played) and the assistant, in the playground.
![Simulation](img/simulate.png)