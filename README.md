![ui](/assets/banner.png)

<h2 align="center">Let AI build multi-agent workflows for you in minutes</h2>
<h5 align="center">

[Quickstart](#quick-start) | [Docs](https://docs.rowboatlabs.com/) | [Website](https://www.rowboatlabs.com/) |  [Discord](https://discord.gg/jHhUKkKHn8) 

</h5>

- ✨ **Start from an idea -> copilot builds your multi-agent workflows**
   - E.g. "Build me an assistant for a food delivery company to handle delivery status and missing items. Include the necessary tools."
- 🌐 **Connect MCP servers**
   - Add the MCP servers in settings -> import the tools into Rowboat.     
- 📞 **Integrate into your app using the HTTP API**
   - Grab the project ID and generated API key from settings and use the API.

Powered by OpenAI's Agents SDK, Rowboat is the fastest way to build multi-agents!

## Quick start
1. Set your OpenAI key
      ```bash
   export OPENAI_API_KEY=your-openai-api-key
   ```
      
2. Clone the repository and start Rowboat docker
   ```bash
   git clone git@github.com:rowboatlabs/rowboat.git
   cd rowboat
   docker-compose up --build
   ```

3. Access the app at [http://localhost:3000](http://localhost:3000).

## Demos

#### Create a multi-agent assistant with tools from a single prompt

[![Prompt to agents](https://img.youtube.com/vi/3t2Fpn6Vyds/0.jpg)](https://www.youtube.com/watch?v=3t2Fpn6Vyds)

#### Add MCP servers

[![MCP server](https://img.youtube.com/vi/EbkIPCTyD58/0.jpg)](https://www.youtube.com/watch?v=EbkIPCTyD58)

#### Use Firecrawl's MCP server and build a quick url scraping agent

[![Firecrawl MCP](https://img.youtube.com/vi/KeXLKh4tUYU/0.jpg)](https://www.youtube.com/watch?v=KeXLKh4tUYU)

#### Improve agents with feedback

[![Feedback](https://img.youtube.com/vi/uoCEQtOe7eE/0.jpg)](https://www.youtube.com/watch?v=uoCEQtOe7eE)


## Integrate with Rowboat agents

There are 2 ways to integrate with the agents you create in Rowboat

1. HTTP API
   - You can use the API directly at [http://localhost:3000/api/v1/](http://localhost:3000/api/v1/)
   - See [API Docs](https://docs.rowboatlabs.com/using_the_api/) for details
   ```bash
   curl --location 'http://localhost:3000/api/v1/<PROJECT_ID>/chat' \
   --header 'Content-Type: application/json' \
   --header 'Authorization: Bearer <API_KEY>' \
   --data '{
       "messages": [
           {
               "role": "user",
               "content": "tell me the weather in london in metric units"
           }
       ]
   }'
   ```
   

2. Python SDK
   - You can use the included Python SDK to interact with the Agents
   - See [SDK Docs](https://docs.rowboatlabs.com/using_the_sdk/) for details
   ```python
   from rowboat import Client
   from rowboat.schema import UserMessage, SystemMessage

   # Initialize the client
   client = Client(
       host="<HOST>",
       project_id="<PROJECT_ID>",
       api_key="<API_KEY>"
   )

   # Create messages
   messages = [
       SystemMessage(role='system', content="You are a helpful assistant"),
       UserMessage(role='user', content="Hello, how are you?")
   ]
   
   # Get response
   response_messages, state = client.chat(messages=messages)
   print(response_messages[-1].content)
   
   # For subsequent messages, include previous messages and state
   messages.extend(response_messages)
   messages.append(UserMessage(role='user', content="What's your name?"))
   response_messages, state = client.chat(messages=messages, state=state)
   ```


Refer to [Docs](https://docs.rowboatlabs.com/) to learn how to start building agents with Rowboat.
