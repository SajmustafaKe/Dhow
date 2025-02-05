## Try an example chat in the playground

### Chat with the assistant

The playground is intended to test out the assistant as you build it. The User and Assistant messages represent the conversation that your end-user will have if your assistant is deployed in production. The playground also has debug elements which show the flow of control between different agents in your system, as well as which agent finally responded to the user.

![Try Chat](img/try-chat.png)

In the playground, you can also set initial context at start of chat, that will be passed to all agents. This is typically used for providing user identity information such as user ID, login email, etc.   
![Use System Message](img/sys-msg.png)

### Ask copilot questions
You can ask copilot clarifications about the chat, such as why the agents responded a certain way or why an agent was invoked.

![Copilot Clarifications](img/copilot-clarifications.png)