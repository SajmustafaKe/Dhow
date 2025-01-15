# Rowboat Python SDK

A Python SDK for interacting with the Rowboat API.

## Installation

You can install the package using pip:

```bash
pip install rowboat
```

## Usage

### Basic Usage

Initialize a client and create a chat session:

```python
from rowboat import Client, StatefulChat

# Initialize the client
client = Client(
    host="<HOST>",
    project_id="<PROJECT_ID>",
    project_secret="<PROJECT_SECRET>"
)

# Create a chat session
chat = StatefulChat(client)

# Send a message and get a response
response = chat.run("Hello, how are you?")
print(response)
```

### Using Tools

The SDK supports function calling through tools. Here's how to use them:

```python
def weather_lookup(city_name: str) -> str:
    # Implement your weather lookup logic here
    return f"The weather in {city_name} is 22°C."

# Create a tools dictionary
tools = {
    'weather_lookup': weather_lookup
}

# Initialize chat with tools
chat = StatefulChat(client, tools=tools)

# The AI can now use the weather tool
response = chat.run("What's the weather in London?")
print(response)
```

### System Prompts

You can initialize the chat with a system prompt to guide the AI's behavior:

```python
chat = StatefulChat(
    client,
    tools=tools,
    system_prompt="You are a helpful assistant who specializes in weather information."
)
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

## License

[Add your license information here]

## Contributing

[Add contribution guidelines here]
