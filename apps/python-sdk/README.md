# Rowboat Python SDK

A Python SDK for interacting with the Rowboat API.

## Installation

You can install the package using pip:

```bash
pip install rowboat
```

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
    project_secret="<PROJECT_SECRET>"
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

## API Reference

### Client

The `Client` class handles communication with the Rowboat API.

```python
Client(host: str, project_id: str, project_secret: str)
```

### StatefulChat

The `StatefulChat` class maintains conversation state across multiple turns.

```python
StatefulChat(
    client: Client,
    tools: Optional[Dict[str, Callable[..., str]]] = None,
    system_prompt: Optional[str] = None
)
```