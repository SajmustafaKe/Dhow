import requests
import json

class StatefulChatbotSDK:
    def __init__(self, project_id, project_secret, tools=None):
        self.base_url = f'http://localhost:3000/api/v1/{project_id}/chat'
        self.headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {project_secret}'
        }
        self.messages = []  # This holds the entire conversation history
        self.state = None
        self.tools = tools if tools else {}  # Default to empty if no tools provided

    def send_message(self, user_message):
        # Add the user's message to the conversation history
        self.messages.append({
            'role': 'user',
            'content': user_message
        })

        # Prepare the payload for the stateless API, including all past messages
        payload = json.dumps({
            'messages': self.messages,
            'state': self.state if self.state else {}
        })

        # Send the request to the API
        response = requests.post(self.base_url, headers=self.headers, data=payload)

        if response.status_code == 200:
            response_data = response.json()
            
            # The response contains only the new messages generated in this turn
            new_messages = response_data.get('messages', [])
            if new_messages:
                # Append new messages to the conversation history
                for msg in new_messages:
                    self.messages.append(msg)

            # Extract the new state from the response and store it
            self.state = response_data.get('state', {})

            # Check for tool calls in the response
            tool_calls = response_data.get('messages', [{}])[0].get('tool_calls', [])
            if tool_calls:
                for tool_call in tool_calls:
                    tool_name = tool_call.get('function', {}).get('name')
                    tool_arguments = json.loads(tool_call.get('function', {}).get('arguments', '{}'))

                    # Invoke the tool if it exists, otherwise raise an error
                    if tool_name in self.tools:
                        tool_response = self.tools[tool_name](**tool_arguments)
                        # Add the tool response as a new message in the conversation history
                        self.messages.append({
                            'role': 'tool',
                            'content': tool_response
                        })
                    else:
                        raise ValueError(f"Missing tool: '{tool_name}'")

            # Return the latest message from the assistant or tool
            return new_messages[-1]['content'] if new_messages else "No response"

        else:
            return f"Error: {response.status_code} - {response.text}"

    def get_conversation_history(self):
        return self.messages

    def reset_conversation(self):
        self.messages = []
        self.state = None


# Example tool functions
def weather_lookup_tool(location, units):
    # Simulating a weather lookup tool response
    return f"The weather in {location} is 22°C with {units} units."

# Interactive conversation loop
if __name__ == "__main__":
    # Initialize the SDK with your project ID and secret
    project_id = "<PROJECT_ID>"
    project_secret = "<PROJECT_SECRET>"
    tools = {
        'weather_lookup_tool': weather_lookup_tool
    }
    chatbot = StatefulChatbotSDK(project_id, project_secret, tools)

    print("Welcome to the chatbot! Type 'exit' to end the conversation.")
    while True:
        user_message = input("You: ")
        
        # Check if the user wants to exit the conversation
        if user_message.lower() == "exit":
            print("Ending the conversation.")
            break
        
        # Send the user message to the chatbot and get the response
        response = chatbot.send_message(user_message)
        
        # Print the chatbot's response
        print(f"Bot: {response}")

    # Optionally, print the conversation history after the chat ends
    print("\nConversation History:")
    for msg in chatbot.get_conversation_history():
        print(f"{msg['role'].capitalize()}: {msg['content']}")
