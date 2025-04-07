![ui](/assets/banner.png)

<h2 align="center">Let AI build multi-agents with MCP for you</h2>
<h5 align="center">

[Quickstart](#quick-start) | [Docs](https://docs.rowboatlabs.com/) | [Website](https://www.rowboatlabs.com/) |  [Discord](https://discord.gg/jHhUKkKHn8) 

</h5>

Build multi-agents in minutes with Rowboat:
- ✨ Start from an Idea -> AI plans and builds the multi-agent system for you
   - E.g. "Build me an assistant for a food delivery company to handle delivery status and missing items. Include the necessary tools."
- 🌐 Connect MCP servers
   - Add the MCP servers in settings -> import the tools into Rowboat.     
- 📞 Integrate into your app using the HTTP API
   - Grab the project ID and generated API key from settings and use the API.

Built with OpenAI's Agents SDK, Rowboat is the fastest way to build multi-agents!

## Quick start

1. **Clone the Repository and start Rowboat docker**
   ```bash
   git clone git@github.com:rowboatlabs/rowboat.git
   cd rowboat
   docker-compose up --build
   ```


4. **Access the App**
   - Visit [http://localhost:3000](http://localhost:3000).

![ui](/assets/ui_revamp_screenshot.png)

## Integrate Rowboat to your app with the HTTP API

You can use the API directly at [http://localhost:3000/api/v1/](http://localhost:3000/api/v1/)
   - Project ID is available in the URL of the project page
   - API Key can be generated from the project config page at `/projects/<PROJECT_ID>/config`

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
   which gives:
   ```json
   {
       "messages": [
           {
               "role": "assistant",
               "tool_calls": [
                   {
                       "function": {
                           "arguments": "{\"location\":\"London\",\"units\":\"metric\"}",
                           "name": "weather_lookup_tool"
                       },
                       "id": "call_r6XKuVxmGRogofkyFZIacdL0",
                       "type": "function"
                   }
               ],
               "agenticSender": "Example Agent",
               "agenticResponseType": "internal"
           }
       ],
       "state": {
           // .. state data
       }
   }
   ```

Refer to [Docs](https://docs.rowboatlabs.com/) to learn how to start building agents with Rowboat.


   
