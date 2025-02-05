# Using the API

This is a guide on using the HTTP API to power conversations with the assistant created in Studio.

## Deploy your assistant to production on Studio
![Prod Deploy](img/prod-deploy.png)

## Obtain API key and Project ID

Generate API keys via the developer configs in your project. Copy the Project ID from the same page.
![Developer Configs](img/dev-config.png)

## Call the API

When you provide your Project ID in the API call, RowBoat uses the version of your assistant deployed to production. 

**Request parameters:** 

- `messages`: history of all messages in the conversation till now (system, user, tool and assistant messages)
- `state`: generated from the previous turn (this is needed because the API does not maintain state on its own)

**Response parameters:**

- `messages`: assistant responses for the current turn (the last message in `messages` is either the user-facing response or a tool call by the assistant)
- `state`: to be passed to the next turn

### API Host
- For the open source installation, the `<HOST>` is [http://localhost:3000](http://localhost:3000)
- When using the hosted app, the `<HOST>` is [https://app.rowboatlabs.com](https://app.rowboatlabs.com)
 
### Example first turn of a chat

#### Request

```bash
curl --location '<HOST>/api/v1/<PROJECT_ID>/chat' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer <API_KEY>' \
--data '{
    "messages": [
        {
            "role": "system",
            "content": "UserID: 345227"
            // Provide context to be passed to all agents in the assistant
            // E.g. user identity info (user ID) for logged in users
        },
        {
            "role": "user",
            "content": "What is my outstanding balance and how do I make the payment?"
        }
    ],
    "state": {
        "last_agent_name": "Credit Card Hub"
        // Last agent used in the previous turn
        // Set to the "start agent" for first turn of chats
    }
}'
```
#### Response
```json
{
    "messages": [
        {
            "sender": "Credit Card Hub",
            "role": "assistant",
            "response_type": "internal",
            "content": null,
            "current_turn": true,
            "tool_calls": [
                {
                  "function": {
                    // Internal tool calls are used to transfer between agents
                    "name": "transfer_to_outstanding_payments",
                    "arguments": "{\"args\":\"\",\"kwargs\":\"\"}"
                  },
                  "id": "call_SLyQKXt9ZMqnxSqJjo9j1fU5",
                  "type": "function"
                }
            ]
        },
        {
          "role": "tool",
          "tool_name": "transfer_to_outstanding_payments",
          "content": "{\"assistant\": \"Outstanding Payments\"}",
          "tool_call_id": "call_SLyQKXt9ZMqnxSqJjo9j1fU5"
        },
        {
            // Last message in response messages is a tool call
            "sender": "Outstanding Payments",
            "role": "assistant",
            "response_type": "internal",
            "content": null,
            "current_turn": true,
            "tool_calls": [
                {
                  "function": {
                    "name": "get_outstanding_balance",
                    "arguments": "{\"user_id\":\"345227\"}"
                  },
                  "id": "call_MNAUg7UTszYMt5RL4n5QqUTw",
                  "type": "function"
                }
            ]
        }
    ],
    "state": {
        "agent_data": [
            // Agents that were involved in this turn
            {
                "name": "Credit Card Hub",
                "instructions": "// agent instructions",
                "history": [ 
                  // History of agent-relevant messages
                  // in the same format as "messages"
                ],
                "child_functions": [
                  "transfer_to_outstanding_payments",
                  "transfer_to_transaction_disputes",
                  "transfer_to_rewards_redemption"
                ],
            },
            {
                "name": "Outstanding Payments",
                "instructions": // Agent instructions,
                "history": [ 
                  // History of agent-relevant messages 
                  // in the same format as "messages"
                ],
                "external_tools": [
                  "get_outstanding_balance",
                  "get_saved_credit_card"
                ],
            },

            // Other agents - have not yet participated in the conversation
            {
                "name": "Rewards Redemption",
                "instructions": // Agent instructions,
                "history": [], // 
            }
        ],
        "last_agent_name": "Outstanding Payments"
    }
}

```

### Example where the assistant is expecting a tool response
#### Request
```bash
curl --location 'http://localhost:3000/api/v1/<PROJECT_ID>/chat' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer <API_KEY>' \
--data '{
    "messages": [
        {
            "role": "system",
            "content": "UserID: 345227"
        },
        {
            "role": "user",
            "content": "What is my outstanding balance and how do I make the payment?"
        },
        {
            "sender": "Credit Card Hub",
            "role": "assistant",
            "response_type": "internal",
            "content": null,
            "tool_calls": [
                {
                "function": {
                    "arguments": "{\"args\":\"\",\"kwargs\":\"\"}",
                    "name": "transfer_to_outstanding_payments"
                },
                "id": "call_SLyQKXt9ZMqnxSqJjo9j1fU5",
                "type": "function"
                }
            ],
        },
        {
            "role": "tool",
            "tool_name": "transfer_to_outstanding_payments",
            "content": "{\"assistant\": \"Outstanding Payments\"}",
            "tool_call_id": "call_SLyQKXt9ZMqnxSqJjo9j1fU5"
        },
        {
            "sender": "Outstanding Payments",
            "role": "assistant",
            "response_type": "internal",
            "content": null,
            "tool_calls": [
                {
                "function": {
                    "arguments": "{\"user_id\":\"345227\"}",
                    "name": "get_outstanding_balance"
                },
                "id": "call_MNAUg7UTszYMt5RL4n5QqUTw",
                "type": "function"
                }
            ],
        },
        {
            // New message is a tool response to the previous tool call
            "role": "tool",
            "tool_name": "get_outstanding_balance"
            "content": "{\"result\":{\"outstanding_balance\":\"$250.00\",\"due_date\":\"2025-02-15\",\"payment_methods\":[\"Credit Card\",\"Bank Transfer\",\"PayPal\"]}}",
            "tool_call_id": "call_MNAUg7UTszYMt5RL4n5QqUTw",
        },
    ],
    "state": {
        // State returned by the API in the previous turn
    }
}'
```
#### Response
```json
{
    "messages": [
        {
            "sender": "Outstanding Payments",
            "role": "assistant",
            // Response is not user-facing, to enable further post processing
            "response_type": "internal",
            "content": "Your outstanding balance is $250.00, due by February 15, 2025.\n\nYou have several payment options available, including:\n- **Credit Card**\n- **Bank Transfer**\n- **PayPal**\n\nPlease let me know which option you'd like to use, and I'll guide you through the process!",
            "current_turn": true
        },
        {
            "sender": "Outstanding Payments >> Post process",
            "role": "assistant",
            // Response is user-facing
            "response_type": "external",
            "content": "Your outstanding balance is $250.00, due by February 15, 2025. \n\nPayment options include:\n- **Credit Card:** You can use your saved Visa card ending in 1234.\n- **Bank Transfer**\n- **PayPal**\n\nLet me know your preferred payment method, and I’ll assist you!",
            "current_turn": true,
        }
    ],
    "state": {
        "agent_data": [
            // Omitted for brevity
        ],
        "last_agent_name": "Outstanding Payments"
    }
}
```