# Chaudecal AI: plan, design and roadmap

This document records what the app is meant to be, the decisions behind it, how it is built, what works today, and what comes next.

## Goal

One app on Mac and Windows that replaces the Claude and ChatGPT apps for daily use, adds local AI running on the PC, keeps every conversation in sync between machines, and lets any conversation move between assistants without losing context.

## Decisions

These were chosen before any code was written.

| Question | Decision |
| --- | --- |
| How to reach Claude and ChatGPT on $20 plans | Hybrid. A native unified chat drives the official Claude Code and Codex command line tools, which sign in with the subscriptions. The real claude.ai and chatgpt.com sites are embedded as tabs for everything else. |
| Framework | Electron, one codebase for both systems. |
| Sync | The PC is the hub and runs an always-on service. The Mac keeps a full offline copy. |
| Local AI | Any OpenAI compatible server, with presets for Ollama and LM Studio, running on the PC. |
| Main uses | Coding and agent work, general chat, writing and research, images and voice. |
| When a limit runs low | Warn and offer. A banner appears at a threshold with a one-click continue. |
| What to hand over | Both a summary with recent messages and the full transcript are kept current. The switch dialog asks each time. |
| Context size | Up to about 400,000 tokens, capped by what the receiving model accepts. |
| Networking | Home network, plus Tailscale when away. |
| Extras in the first version | Compare mode, smart routing, search across everything, shared memory and prompts. |
| Installing on the PC | Installers built automatically by GitHub Actions on every push. |
| Look and feel | Follows the Claude and ChatGPT apps: warm neutral colors, a sidebar, one centered column, a rounded message box, light and dark. |

The PC this was planned around: Ryzen 9 9850X3D, Radeon RX 9070 XT 16 GB, 32 GB DDR5.

## The constraint that shapes everything

Claude Pro and ChatGPT Plus do not include API access. The only supported way to use those plans from another program is through the command line tools each company ships:

- `claude -p --output-format stream-json` for Claude. One process per turn. Sessions resume by id.
- `codex app-server` for ChatGPT. One long-lived process speaking JSON-RPC over standard input and output. Threads resume by id.

Both report the plan's rate limits, which is what makes the usage tracker and the limit banner possible without scraping anything.

What the tools do not expose (image generation, voice, projects, artifacts, account pages) is covered by the embedded websites.

## Architecture

```
            Mac                                         PC (hub)
  +-----------------------+                  +---------------------------+
  |  Window (React)       |                  |  Window (React)           |
  |-----------------------|                  |---------------------------|
  |  Chat engine          |                  |  Chat engine              |
  |   Claude  -> claude   |                  |   Claude  -> claude       |
  |   ChatGPT -> codex    |                  |   ChatGPT -> codex        |
  |   Local   -> hub  ----+---- HTTP --------+-> Local -> Ollama,        |
  |-----------------------|   (home network  |            LM Studio      |
  |  Store (SQLite)       |    or Tailscale) |---------------------------|
  |  Hub client  <--------+---- sync --------+-> Hub server              |
  +-----------------------+                  |  Store (SQLite)           |
                                             +---------------------------+
```

### Conversations that belong to no single assistant

A conversation is a list of messages. Each assistant message records which provider and model wrote it. Nothing about the conversation is tied to one service.

Each device remembers, for each conversation and each provider, the provider's own session id and the last message that provider has seen. Before a turn the engine decides one of four things:

| Plan | When | What is sent |
| --- | --- | --- |
| Fresh | First message of the conversation | Just the message |
| Resume | The provider wrote the previous reply on this device | Just the message, on the existing session |
| Catch-up | The provider has a session here but missed some messages | Only the messages it has not seen, then the new message |
| Handoff | The provider has never seen this conversation on this device | The context file, then the new message |

This keeps switching cheap. Going back to an assistant that was used earlier costs only the messages in between, not the whole conversation again.

### The running context files

After every turn the app writes two Markdown files for the conversation:

- `summary.md`: a rolling summary followed by the most recent messages in full.
- `full.md`: the complete transcript.

Each is trimmed to the context budget (400,000 tokens by default) and then to what the receiving model can take, leaving a quarter of its window free for the reply. The rolling summary is written by a local model when one is available, so it costs nothing against either plan. Otherwise the app extracts key lines.

### Sync

Every conversation, message, memory note and saved prompt is a small record with an id, a last-changed time and the device that changed it. The newest change to a record wins. Because each message is its own record, two machines adding messages to the same conversation merge cleanly.

The hub numbers every change it accepts. A client remembers the last number it has seen and asks for everything after it, then sends its own unsent changes. A live event stream tells connected clients when to pull. The pairing code is a bearer token sent with every request.

The hub is found on the home network through mDNS. Away from home the Mac uses the PC's Tailscale address.

### Local AI

The app speaks the two OpenAI compatible routes every local runtime offers: list models and stream a chat completion. On the Mac those requests go to the hub, which forwards them to the runtime on the PC. Local models are stateless, so the app sends the trimmed conversation with each request.

### Storage

SQLite through Node's built-in driver, with full text search for the search box. No native modules, which keeps the Windows and Mac builds simple.

### Safety choices

- The window runs sandboxed with no Node access. It talks to the main process through a fixed list of calls.
- Rendered Markdown is sanitized.
- Chat mode gives the assistants no access to files or the shell. File access is opt-in per conversation, inside one folder.
- API key variables are removed from the command line tools' environment so a stray key cannot cause surprise charges.
- The website tabs use separate storage from the rest of the app.

## What is built and tested

| Area | State |
| --- | --- |
| Unified chat with streaming, thinking, tool activity, stop and retry | Built, tested |
| Claude through Claude Code | Built, tested against a stand-in |
| ChatGPT through Codex | Built, tested against a stand-in and against the real service |
| Local AI, direct and through the hub | Built, tested against a stand-in server |
| Model picker for each assistant | Built |
| Chat, Plan, Edit and Auto modes with a working folder | Built |
| Approvals (live for ChatGPT, after the turn for Claude) | Built, tested |
| Running context files and the switch dialog | Built, tested |
| Usage tracker and limit banner | Built, tested |
| Smart routing | Built, tested |
| Compare mode | Built, tested |
| Search across everything | Built, tested |
| Shared memory, profile and saved prompts | Built, tested |
| Hub, client, offline changes, discovery | Built, tested with two app instances on one machine |
| Website tabs and bringing a web chat in | Built. Loading is tested. Capture is best effort and depends on each site's page layout. |
| Light and dark themes | Built, tested |
| Mac installer | Built and launched |
| Windows installer | Built by GitHub Actions. Not yet run on a real PC. |

Not verified yet: real answers from Claude on the development Mac (its command line sign-in had expired), real Ollama and LM Studio, sync between two physical machines, and anything on Windows beyond the automated build.

## Roadmap

### Next

1. **Hub in the system tray.** Keep the hub running when the window is closed, and start it with Windows.
2. **Remote agent work.** Let the Mac start Claude or ChatGPT agent work on the PC through the hub, so long tasks run on the desktop while the laptop sleeps.
3. **Attachments in the unified chat.** Images, PDFs and files in the message box, passed to whichever assistant is answering.
4. **Live approvals for Claude.** Ask during the turn, not after it, using the permission prompt hook in Claude Code.
5. **Automatic updates** from GitHub Releases.
6. **Signed builds**, so neither system warns on first launch. This needs paid developer accounts.

### Suggested features

- **Automatic failover.** An option to continue on the other assistant without asking when a limit is hit in the middle of a long task.
- **Limit forecast.** Predict when the current window will run out at the present pace, and suggest saving the stronger model for harder questions.
- **Voice.** Dictation with a local speech model on the PC, and spoken replies.
- **Local image generation** on the 9070 XT through a ComfyUI connection.
- **Local models with tools.** File reading and web search for local models through MCP.
- **Projects.** Group conversations with shared files and instructions that every assistant receives.
- **Branching.** Fork a conversation at any message to try a different direction.
- **Second opinion.** One click to have another assistant review the last answer.
- **Scheduled prompts.** Run a saved prompt every morning on the PC and sync the result.
- **Quick ask.** A global shortcut that opens a small window over whatever you are doing.
- **Import.** Bring in the official data exports from Claude and ChatGPT so old conversations are searchable.
- **Encrypted backup** of the hub's database to a folder or cloud drive.
- **Phone access.** A small web page served by the hub, reachable over Tailscale.
- **Cost view.** What the same usage would have cost on the APIs, to show what the plans are worth.

## Risks

- **Provider changes.** The app depends on two command line tools whose output formats and terms can change. The parsers are small and isolated, and stand-in programs in the tests make changes easy to spot.
- **Website tabs.** Either site can change its sign-in flow or page layout. The tabs are a convenience, and the unified chat does not depend on them.
- **Unsigned builds.** Both systems warn on first launch until the builds are signed.
- **The pairing code is the only lock on the hub.** Keep the hub on the home network and Tailscale. Do not forward its port to the internet.
