# Agents

## Overview
- Agents carry out a specific part of the conversation and / or perform tasks like orchestrating between other agents, triggering internal processes and fetching information.
- Agents carry out tasks through tools provided to them.
- Agents are connected to each other in a Directed Acyclic Graph (DAG). Hence, every agent has a parent agent and children agents, to which they can pass control of the conversation to. 

## Agent Configurations

### Description
The description conveys the agent's role in the multi-agent system. Writing a good description is important for other agents to know when to pass control of the conversation to an agent.

### Instructions
Agent instructions are the backbone of an agent, defining its behavior. RowBoat Studio's copilot produces a good framework for agent instructions, involving Role, Steps to Follow, Scope and Guidelines. Since agents are powered by LLMs, general best practices while writing prompts apply. 

### Examples
Coming soon.

### Model
Coming soon.

### Control
Coming soon.