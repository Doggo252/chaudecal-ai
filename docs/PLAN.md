# Chaude: plan, design and roadmap

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

### Remote work

A conversation can be marked to run on the hub. When a message is sent in one from another device, that device first makes sure the hub has everything (the conversation, earlier messages, attached images), then asks the hub to answer. The hub's own conversation engine does exactly what it does for a message typed at the hub: it picks the provider, resumes or catches up that provider's session, and runs it in a folder on the hub.

Progress is sent to connected devices over the same event stream that announces sync changes, throttled so a long reply does not flood the connection. The finished messages arrive through ordinary sync. A device shows a run as finished only once the saved reply is there, so the live copy never disappears first. Stop and approval answers go back to the hub as small requests. When a question has been answered, on any device or by the assistant withdrawing it, the hub says so on the same stream and every window removes its card.

The provider sessions live on the hub, so they survive the other device sleeping, and a run started from the Mac can be continued at the PC or the other way round.

The working folder is a folder on the hub, so the other device chooses it by asking the hub what folders it has. The hub answers one folder at a time with the names of the folders inside it, never files, and without hidden or system folders. It also gives a few starting points: the home folder, Desktop, Documents and Downloads, and on Windows each drive. The same switch that allows remote work gates this.

This is off by default, because it allows a paired device to run commands on the hub.

### Permission questions

Both command line tools can stop in the middle of a turn and ask whether an action is allowed. ChatGPT's tool sends an approval request over its app server connection. Claude Code is started with its permission prompt set to the standard streams: it then writes a `can_use_tool` request on its output and waits for an allow or deny answer on its input, which the app keeps open until the turn ends. This is the same exchange Anthropic's own Agent SDK uses.

The app turns either kind into one approval card. Two requests are answered without a card because they only make sense in Claude Code's own window: leaving plan mode (Claude is told to give the plan as its reply) and multiple choice questions (Claude is told to ask in its reply). Compare answers are one-off runs with nobody watching for questions, so they never ask.

If the installed Claude Code does not know the option, the first attempt fails before producing anything. The app then runs the turn the earlier way, remembers that for the session, and lists blocked actions after the turn.

### Tool servers (MCP)

The app keeps one list of tool servers and hands it to whichever assistant is answering. Each entry is a synced record: a name, either a command with its arguments and environment variables or a web address with its headers, whether its tools may run without asking, and the devices on which it is switched off.

Neither command line tool is reconfigured on disk. Claude Code gets the list for one turn in a file named with `--mcp-config`, readable only by the user and deleted when the turn ends. Codex gets it as a `mcp_servers` configuration override when a conversation is opened or resumed. The servers a user added to either tool themselves are left alone and keep working.

Permission uses the cards that already exist. Claude Code asks about a server's tool like about any other tool. Codex sends a form request marked as a tool approval, which the app shows as the same card and answers in Codex's own shape. Codex can only ask when asking is switched on, so in Chat, Plan and Auto mode (which normally never ask) the app switches it on whenever an untrusted server is present, and refuses requests to run commands outside the sandbox itself, as before. A trusted server is passed to Claude as a permission rule for the whole server and to Codex with its tools pre-approved.

Codex keeps open conversations in one long-lived process, and a conversation that is open there keeps the settings it was opened with. Two things follow. When the list of servers changes, the app replaces that process as soon as no reply is being written. And the approval and sandbox settings are sent again with every turn. That also makes a change of mode in the middle of a ChatGPT conversation take effect at once. In a check against the real Codex it did not before: the conversation stayed read-only after a switch from Chat to Auto.

The "Test" button uses a small client of the app's own that starts the program or calls the address, asks for the tool list and stops. It is not used during a chat.

Tokens are synced with the rest of the record so that a server added on one machine works on the other, and on the hub for remote work. They are removed from the record when a server is deleted.

### Notifications

A run is announced by the device that sent the message, and only while its window is not in front. That device remembers which conversations it started a run in, so the hub says nothing about work another device asked for. The one exception is a permission question on the hub with no other device connected: the run would wait unnoticed, so the hub announces it.

A reply is announced only if the run produced a new one, and one the user stopped is not announced. A question's notification is withdrawn when the question is answered or dropped. Private chats are announced without their title or contents.

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
- Outside Auto mode an assistant has to ask before it runs a command, and the question shows the exact command. Something allowed "for this chat" is stored as the narrowest rule that covers it (one exact command, not the whole shell), stays on the machine doing the work, and is dropped when the conversation's folder changes.
- A tool server's tool asks before it is used unless the user marked that server as trusted. The card names the server and the tool and shows what is sent. A tool is named by its server and its own name, never by a title the server chooses for it.
- API key variables are removed from the command line tools' environment so a stray key cannot cause surprise charges.
- The website tabs use separate storage from the rest of the app.

## Artifacts

Artifacts are found in the text of a reply, not in anything a provider sends separately, so they work the same for Claude, ChatGPT and local models, and they sync with the messages without any new record kind. A fenced code block is an artifact when its opening line has a title (```` ```html title="Pricing page" ````), or without a title when it is a full web page, an SVG, a Mermaid diagram or a React component with a default export. The same title later in the conversation is a new version of the same artifact. While artifacts are on (the default), every assistant gets a short guide to this in its system text.

The preview runs in a frame with `sandbox="allow-scripts"` and no same-origin access, so it cannot reach the app or the bridge to the main process. The window's own content policy would block a preview's scripts, and a page written straight into a frame inherits that policy, so the main process serves each preview page under a private `chaudecal-artifact:` scheme with its own strict policy: no requests anywhere except scripts, styles and fonts from a few public code hosts, images only from inside the page, no forms, no frames. Frames in the window may not go anywhere else (`will-frame-navigate`), and a preview's links are stopped inside the page. React components are compiled in the window with sucrase (loaded only when a preview first opens) and load React from esm.sh through an import map, so packages from esm.sh share one copy of React. The page reports errors to the panel as one short line of text, which "Ask to fix" sends back to the assistant.

## Bringing in chats from the websites

The app reads the user's chats the way the sites' own pages do: the request runs inside the hidden claude.ai or chatgpt.com tab (`WebTabs.request`), so it carries that tab's sign-in, and only paths on the site itself can be asked for. ChatGPT: the session's access token, then the conversation list (ordinary, archived, and each project's), then each chat's message tree, following the branch the user last saw. Claude: the organization that can chat, the paged chat list (falling back to the older single list), then each chat with its message tree. Thinking, tool steps, hidden and system messages are left out. Claude's artifacts (the artifacts tool, and the newer file tools) become artifact blocks with their titles, so they open in the panel with their versions.

Imported chats and messages get ids made from their ids on the site, so two devices that both import never duplicate anything, and sync treats them like any other records. Each conversation keeps the site's update time, and later runs fetch only chats whose time changed. A deleted chat is never brought back, a title changed in the app is kept, and messages that left the site's chat (an edited question starts a new branch) are removed, while messages written in the app stay. The sites are asked one chat at a time with a short pause, and a "slow down" answer is waited out.

## What is built and tested

| Area | State |
| --- | --- |
| Unified chat with streaming, thinking, tool activity, stop and retry | Built, tested |
| Claude through Claude Code | Built, tested against a stand-in |
| ChatGPT through Codex | Built, tested against a stand-in and against the real service |
| Local AI, direct and through the hub | Built, tested against a stand-in server |
| Model picker for each assistant | Built |
| Chat, Plan, Edit and Auto modes with a working folder | Built |
| Approvals during the turn, for Claude and ChatGPT, on this device and across devices | Built, tested against stand-ins. Real Claude Code accepts the option and the message format. A real question from Claude has not been answered yet (see below). |
| Running context files and the switch dialog | Built, tested |
| Usage tracker and limit banner | Built, tested |
| Smart routing | Built, tested |
| Compare mode | Built, tested |
| Search across everything | Built, tested |
| Shared memory, profile and saved prompts | Built, tested |
| Hub, client, offline changes, discovery | Built, tested with two app instances on one machine |
| Website tabs and bringing a web chat in | Built. Loading is tested. Capture is best effort and depends on each site's page layout. |
| Attachments: images, PDFs and text files, picked, pasted or dropped | Built, tested. Image input is checked against real ChatGPT. PDF reading is checked on real documents and in the packaged Mac app. |
| Tool servers (MCP) shared by Claude and ChatGPT, with a settings page, a test button and sync | Built, tested against stand-in assistants with a real stand-in tool server. Checked against the real Codex: it started the server, asked before a tool that changes something, used it, and did not ask for a trusted server. Real Claude Code loads the servers and lists their tools. A real tool call by Claude is unchecked (see below). Not tried with a hosted server or on Windows. |
| Second opinion and branching | Built, tested |
| Automatic failover at a limit (off by default) | Built, tested |
| Hub stays in the system tray, start at sign-in | Built. The decision logic is tested. Not yet run on a real PC. |
| Updates that download in the background, are checked against the release's checksum, and install on "Restart to update" | Built, tested. The Mac path was run for real between two packaged versions (`node e2e/update-mac.mjs`). The Windows path runs the installer silently and is unchecked on a real PC. |
| Renamed to Chaude, keeping the old data folder | Built |
| Remote work: a conversation typed on one device runs on the hub | Built, tested with two app instances. Not yet run between two real machines. |
| Choosing the hub's working folder from another device by browsing its folders | Built, tested with two app instances on a Mac. Drive letters and Windows paths are in code only. |
| Notifications for a finished reply or a waiting question, with a Dock count and a sidebar marker | Built. When and what to announce is tested, including across two app instances. A real notification was shown by the packaged Mac app. Not yet seen on Windows. |
| Light and dark themes, an accent color (seven presets or any color), and four text sizes | Built, tested |
| Bringing in chats from claude.ai and chatgpt.com through the website tabs' sign-ins, with archived and project chats, Claude artifacts and attached text, and an optional refresh every 30 minutes | Built, tested against stand-in sites that serve the shapes open-source exporters read (November 2026), in the real window and across two devices. Not yet run against the real sites. |
| Artifacts: web pages, React components, SVG, Mermaid, documents and code in a side panel with live previews and versions | Built, tested against a stand-in assistant in the real window, including the sealed-off preview. React and Mermaid previews checked with the real libraries from the internet. Not yet checked with real Claude or ChatGPT replies. |
| Mac installer | Built and launched |
| Windows installer | Built by GitHub Actions. Not yet run on a real PC. |

Not verified yet: real answers from Claude on the development Mac (its command line sign-in had expired, so image input to real Claude, a real permission question from Claude and a real tool server call by Claude are also unchecked), real Ollama and LM Studio, sync between two physical machines, and anything on Windows beyond the automated build.

### How attachments work

An image is stored as its own record, so it syncs like a message does. Sync batches are capped by size so a few large images cannot stall it. Each assistant gets the image in the form it expects: Claude as one structured message on standard input, ChatGPT as a file on disk, a local model as a data URL. A text file is read once and kept inside the message, which puts it in the transcript and both context files. When an assistant has to be caught up on a conversation, the four most recent images it has not seen are sent with the context file.

A PDF is read in the app, page by page, with a marker at the start of each page, and from then on it is a text file like any other. That is the one form all three kinds of assistant accept, it needs nothing installed, and it survives a handoff. The cost is that pictures and scanned pages are not read. The reader is a JavaScript library with no native parts, so it works the same on Mac and Windows.

## Roadmap

### Next

1. **Tool servers that sign in through a browser.** Many hosted tool servers use that kind of sign-in. Today only servers that take a token, or run as a program, can be added.
2. **Scanned PDFs and pictures inside PDFs.** Today only the text of a PDF is read. Pages with no text could be sent as images.
3. **Tell a device about replies that finished while it was away**, when it reconnects.
4. **Create a new folder on the hub** from the folder browser.
5. **Answer Claude's own questions in the app.** When Claude wants to ask a multiple choice question, it is told to ask in its reply. A proper form would be nicer.
6. **Signed builds**, so neither system warns on first launch. This needs paid developer accounts.

### Suggested features

- **Limit forecast.** Predict when the current window will run out at the present pace, and suggest saving the stronger model for harder questions.
- **Voice.** Dictation with a local speech model on the PC, and spoken replies.
- **Local image generation** on the 9070 XT through a ComfyUI connection.
- **Local models with tools.** Let local models use the same tool servers as Claude and ChatGPT. This needs the app to run the tool loop itself, and a local model that can call tools.
- **Projects.** Group conversations with shared files and instructions that every assistant receives.
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
- **The pairing code is the only lock on the hub.** Keep the hub on the home network and Tailscale. Do not forward its port to the internet. With remote work turned on, the code is also enough to run commands on the hub, so it matters more.
