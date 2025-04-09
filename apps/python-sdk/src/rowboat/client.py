from typing import Dict, List, Optional, Any, Union
import requests
from .schema import (
    ApiRequest, 
    ApiResponse, 
    ApiMessage, 
    UserMessage, 
    AssistantMessage, 
    AssistantMessageWithToolCalls
)

class Client:
    def __init__(self, host: str, project_id: str, api_key: str) -> None:
        self.base_url: str = f'{host}/api/v1/{project_id}/chat'
        self.headers: Dict[str, str] = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}'
        }

    def _call_api(
        self, 
        messages: List[ApiMessage],
        state: Optional[Dict[str, Any]] = None,
        workflow_id: Optional[str] = None,
        test_profile_id: Optional[str] = None
    ) -> ApiResponse:
        request = ApiRequest(
            messages=messages,
            state=state,
            workflowId=workflow_id,
            testProfileId=test_profile_id
        )
        json_data = request.model_dump()
        response = requests.post(self.base_url, headers=self.headers, json=json_data)

        if not response.status_code == 200:
            raise ValueError(f"Error: {response.status_code} - {response.text}")
    
        response_data = ApiResponse.model_validate(response.json())
        
        if not response_data.messages:
            raise ValueError("No response")
            
        last_message = response_data.messages[-1]
        if not isinstance(last_message, (AssistantMessage, AssistantMessageWithToolCalls)):
            raise ValueError("Last message was not an assistant message")

        return response_data

    def chat(
        self,
        messages: List[ApiMessage],
        state: Optional[Dict[str, Any]] = None,
        workflow_id: Optional[str] = None,
        test_profile_id: Optional[str] = None
    ) -> ApiResponse:
        """Stateless chat method that handles a single conversation turn"""
        
        # call api
        response_data = self._call_api(
            messages=messages,
            state=state,
            workflow_id=workflow_id,
            test_profile_id=test_profile_id
        )

        if not response_data.messages[-1].agenticResponseType == 'external':
            raise ValueError("Last message was not an external message")

        return response_data

class StatefulChat:
    """Maintains conversation state across multiple turns"""
    
    def __init__(
        self,
        client: Client,
        workflow_id: Optional[str] = None,
        test_profile_id: Optional[str] = None
    ) -> None:
        self.client = client
        self.messages: List[ApiMessage] = []
        self.state: Optional[Dict[str, Any]] = None
        self.workflow_id = workflow_id
        self.test_profile_id = test_profile_id

    def run(self, message: Union[str]) -> str:
        """Handle a single user turn in the conversation"""
        
        # Process the message
        user_msg = UserMessage(role='user', content=message)
        self.messages.append(user_msg)

        # Get response using the client's chat method
        response_data = self.client.chat(
            messages=self.messages,
            state=self.state,
            workflow_id=self.workflow_id,
            test_profile_id=self.test_profile_id
        )
        
        # Update internal state
        self.messages.extend(response_data.messages)
        self.state = response_data.state
        
        # Return only the final message content
        last_message = self.messages[-1]
        return last_message.content


def weather_lookup_tool(city_name: str) -> str:
    return f"The weather in {city_name} is 22°C."


if __name__ == "__main__":
    host: str = "<HOST>"
    project_id: str = "<PROJECT_ID>"
    api_key: str = "<API_KEY>"
    client = Client(host, project_id, api_key)

    result = client.chat(
        messages=[
            UserMessage(role='user', content="Hello")
        ]
    )
    print(result.messages[-1].content)

    chat_session = StatefulChat(client)
    resp = chat_session.run("Hello")
    print(resp)