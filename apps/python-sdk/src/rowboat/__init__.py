from .client import Client, StatefulChat
from .schema import (
    ApiMessage,
    UserMessage,
    SystemMessage,
    AssistantMessage,
    AssistantMessageWithToolCalls,
    ToolMessage,
    ApiRequest,
    ApiResponse
)

__version__ = "0.1.0"

__all__ = [
    "Client",
    "StatefulChat",
    # Message types
    "ApiMessage",
    "UserMessage",
    "SystemMessage",
    "AssistantMessage",
    "AssistantMessageWithToolCalls",
    "ToolMessage",
    # Request/Response types
    "ApiRequest",
    "ApiResponse",
] 