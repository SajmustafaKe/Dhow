# Using the Python SDK

This is a guide on using the RowBoat Python SDK as an alternative to the [RowBoat HTTP API](/using_the_api) to power conversations with the assistant created in Studio.

## Prerequisites
- [Deploy your assistant to production](/using_the_api/#deploy-your-assistant-to-production-on-studio) and [obtain your API key and Project ID](/using_the_api/#obtain-api-key-and-project-id)
- ``` pip install rowboat ```

## Usage

### Basic Usage

Initialize a client and use the chat method directly:

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

### Using Tools

The SDK supports function calling through tools:

```python
def weather_lookup(city_name: str) -> str:
    return f"The weather in {city_name} is 22°C."

# Create a tools dictionary
tools = {
    'weather_lookup': weather_lookup
}

# Use tools with the chat method
response_messages, state = client.chat(
    messages=messages,
    tools=tools
)
```
The last message in `response_messages` is either a user-facing response or a tool call by the assistant. 

### Stateful Chat (Convenience Wrapper)

For simpler use cases, the SDK provides a `StatefulChat` class that maintains conversation state automatically:

```python
from rowboat import StatefulChat

# Initialize stateful chat
chat = StatefulChat(
    client,
    tools=tools,
    system_prompt="You are a helpful assistant."
)

# Simply send messages and get responses
response = chat.run("Hello, how are you?")
print(response)
# I'm good, thanks! How can I help you today?
```