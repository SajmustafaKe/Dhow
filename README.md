<p align="center">
  <img width="140" height="140" alt="Dhow" src="apps/x/apps/main/icons/icon.png" />
</p>

<h1 align="center">Dhow</h1>
<p align="center">A desktop AI coworker with a memory of your work and built-in surfaces to act on it.</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue"></a>
  <a href="https://github.com/SajmustafaKe/Dhow/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/SajmustafaKe/Dhow?display_name=tag"></a>
</p>

Dhow indexes your work into a living knowledge graph and uses that to get work done on your machine. It includes work surfaces for collaborating with AI: email client, notes, browser, code mode, meeting note taker, and workspaces for different projects.


Download latest for Mac/Windows/Linux: [Download](https://github.com/SajmustafaKe/Dhow/releases)

<p align="center">
<a href="https://www.youtube.com/watch?v=et5yQABJ3xI">
<img width="800" height="450" alt="Dhow Apps to Code demo" src="apps/x/demo.gif" />
</a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=et5yQABJ3xI"> Demo - apps to code </a> · <a href="https://www.youtube.com/watch?v=7xTpciZCfpw"> Demo - knowledge graph</a>
</p>


⭐ If you find Dhow useful, please star the repo. It helps more people find it.

---
## Overview

<table>
<tr>
<td width="40%" valign="middle">
<h3>Brain</h3>
Dhow indexes email, meetings, slack and assistant conversations into a living Obsidian-style backlinked knowledge graph.
</td>
<td width="60%">
<img width="1502" height="939" alt="Brain graph screenshot" src="assets/readme-dark/brain.png" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Email</h3>
The built-in email client sorts emails into important and everything else. Dhow automatically drafts responses for important email using all the work context.
</td>
<td width="60%">
<img width="1512" height="948" alt="Email screenshot" src="assets/readme-dark/email.png" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Background agents</h3>
You can set up background agents that run on events like new email or on schedule like every day at 8am. They can connect to tools, search the web, use the browser and write code using Claude Code or Codex.
</td>
<td width="60%">
<img width="1512" height="951" alt="Background agents screenshot" src="assets/readme-dark/background-agents.png" />

</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Built-in Browser</h3>
Dhow includes a browser that lets you and assistant collaborate on web tasks. Because it's isolated from your main browser, you can log in only to the accounts that want the assistant to access.
</td>
<td width="60%">
<img width="1512" height="948" alt="Browser screenshot" src="assets/readme-dark/browser.png" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Meeting Notes</h3>
A local meeting note-taker that taps into mic & speaker, produces live transcript and summarizes the meeting in a markdown file and updates the knowledge graph.
</td>
<td width="60%">
<img width="1512" height="947" alt="Meeting notes screenshot" src="assets/readme-dark/meeting-notes.png" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Code Mode</h3>
Code mode lets you spin up parallel coding agents with Claude Code or Codex, and have Dhow drive them with all the work context where needed.
</td>
<td width="60%">
<img width="1512" height="949" alt="Code mode screenshot" src="assets/readme-dark/code-mode.png" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Apps</h3>
You can build your own work surfaces inside Dhow — they get access to all the tools and integrations, and you can share them with other people.
</td>
<td width="60%">
<img width="1512" height="949" alt="Apps screenshot" src="assets/readme-dark/apps.png" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Integrations</h3>
Includes one-click integrations to most popular products.
</td>
<td width="60%">
<img width="1512" height="948" alt="Integrations screenshot" src="assets/readme-dark/integrations.png" />
</td>
</tr>

</table>

---

## Installation

**Download latest for Mac/Windows/Linux:** [Download](https://github.com/SajmustafaKe/Dhow/releases)

**All release files:**   https://github.com/SajmustafaKe/Dhow/releases/latest

### Google setup
To connect Google services (Gmail, Calendar, and Drive), follow [Google setup](https://github.com/SajmustafaKe/Dhow/blob/main/google-setup.md).

### Voice input
To enable voice input and voice notes (optional), add a Deepgram API key in `~/.dhow/config/deepgram.json`

### Voice output

To enable voice output (optional), add an ElevenLabs API key in `~/.dhow/config/elevenlabs.json`

### Web search

To use Exa research search (optional), add the Exa API key in `~/.dhow/config/exa-search.json`

### External tools

To enable external tools (optional), you can add any MCP server or use Composio tools by adding an API key in `~/.dhow/config/composio.json`

All API key files use the same format:
```
{
  "apiKey": "<key>"
}
```


## How it’s different

Most AI tools reconstruct context on demand by searching transcripts or documents.

Dhow maintains **long-lived knowledge** instead:
- context accumulates over time
- relationships are explicit and inspectable
- notes are editable by you, not hidden inside a model
- everything lives on your machine as plain Markdown

The result is memory that compounds, rather than retrieval that starts cold every time.

## Bring your own model

Dhow works with the model setup you prefer:
- **Local models** via Ollama or LM Studio
- **Hosted models** (bring your own API key/provider)
- Swap models anytime — your data stays in your local Markdown vault

## Extend Dhow with tools (MCP)

Dhow can connect to external tools and services via **Model Context Protocol (MCP)**.
That means you can plug in (for example) search, databases, CRMs, support tools, and automations - or your own internal tools.

Examples: Exa (web search), Twitter/X, ElevenLabs (voice), Slack, Linear/Jira, GitHub, and more.

## Local-first by design

- All data is stored locally as plain Markdown
- No proprietary formats or hosted lock-in
- You can inspect, edit, back up, or delete everything at any time

---

## Attribution

Dhow is a fork of [Rowboat](https://github.com/rowboatlabs/rowboat) by RowBoat Labs, used
under the [Apache License 2.0](LICENSE). **This code has been modified from the original.**

Notable changes in this fork:

- Rebranded to Dhow — application name, bundle identifier `com.dhow.app`, the `dhow://`
  URL scheme, and the `~/.dhow` home directory.
- Removed all product analytics. Dhow sends no telemetry.
- Removed the hosted RowBoat account, billing, credits, and the managed model gateway.
  Dhow is bring-your-own-key only: the backing service was never open source and is not
  part of this repository.
- Google, web search, voice, and Composio now authenticate with your own credentials
  instead of going through RowBoat Labs' infrastructure.

The `LICENSE` file and its original copyright notice are retained unchanged, as the
licence requires.
