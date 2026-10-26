# Agent Huddle

**One chat room for all your AI coding agents.** You, Claude Code, OpenAI Codex, Grok, Cursor and Google Antigravity talk in the same conversation. Agents can hand work to each other, you approve anything risky from the chat, and every message shows who asked for it. It runs on your own Mac, and you can reach it from your phone.

Agent Huddle is a free, open-source personal project. It isn't affiliated with, endorsed by or sponsored by Anthropic, OpenAI, xAI, Anysphere (Cursor) or Google. Their product names are used only to say which tools it works with.

> [!WARNING]
> **Read [Terms of service risks](#terms-of-service-risks) before you use Agent Huddle with a subscription login (Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, Cursor Pro or a Google account).** Some providers' terms don't allow their subscription logins to be used through third-party software, and they can suspend accounts that do. Using **API keys** is the safe option. You alone are responsible for how you use Agent Huddle with your accounts.

---

## Contents

1. [Terms of service risks](#terms-of-service-risks)
2. [What it does](#what-it-does)
3. [How it works](#how-it-works)
4. [Requirements](#requirements)
5. [Quick start (Mac)](#quick-start-mac)
6. [Installing and signing in to the agents](#installing-and-signing-in-to-the-agents)
7. [Using Agent Huddle](#using-agent-huddle)
8. [Phone access](#phone-access)
9. [Security and privacy](#security-and-privacy)
10. [Configuration reference](#configuration-reference)
11. [The cloud version (Cloudflare)](#the-cloud-version-cloudflare)
12. [Running your own phone relay](#running-your-own-phone-relay)
13. [Building and releasing the Mac app](#building-and-releasing-the-mac-app)
14. [Project structure](#project-structure)
15. [Development and testing](#development-and-testing)
16. [Troubleshooting](#troubleshooting)
17. [FAQ](#faq)
18. [Contributing](#contributing)
19. [Licence and disclaimer](#licence-and-disclaimer)

---

## Terms of service risks

Agent Huddle drives each provider's **official command-line tool** (CLI) on your Mac: `claude`, `codex`, `grok`, `cursor-agent` and `agy`. Each CLI is signed in by you, with your own account. Agent Huddle never sees your passwords. In the Mac app it doesn't read, store or forward the CLIs' login tokens. The cloud version is an exception, described below.

Even so, **using a subscription login through a third-party app like this one can break some providers' terms**, whether or not the app is free or open source. If that happens, the provider can **suspend or close your account**. That risk is yours, not this project's.

This summary comes from the providers' public terms as they read in **October 2026**. Terms change. **Read the current versions yourself**; the links are below. **This isn't legal advice.**

| Provider | Subscription login through Agent Huddle | With an API key |
| --- | --- | --- |
| **Google Antigravity** (`agy`) | **High risk.** Google's [Antigravity Additional Terms](https://antigravity.google/terms) treat "using third party software, tools, or services to access the Service" as a breach, and say it can lead to suspension of your Antigravity and Gemini CLI accounts. | Allowed through the paid [Gemini API](https://ai.google.dev/gemini-api/terms). In the UK, EEA and Switzerland, apps must use the paid tier. |
| **Anthropic Claude Code** (`claude`) | **Grey area, leaning against.** Signing in to the unmodified Claude Code program with your own subscription is allowed. But Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says third-party developers may not route requests through Free, Pro or Max plan credentials on behalf of users, or collect or store Claude.ai credentials or tokens. Its [Usage Policy](https://www.anthropic.com/legal/aup) also covers services that route requests through consumer subscriptions. **Pasting a `claude setup-token` token into the cloud version is not allowed.** | Allowed under Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms). |
| **OpenAI Codex** (`codex`) | **Grey area.** Codex reuses your saved ChatGPT login by default, but OpenAI's [Codex docs](https://developers.openai.com/codex) recommend API keys for automation. Apps that use ChatGPT plans officially go through OpenAI's "Sign in with ChatGPT" programme, which Agent Huddle isn't part of. See also the [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [Usage Policies](https://openai.com/policies/usage-policies/). | Allowed. |
| **xAI Grok** (`grok`) | **Grey area, leaning against.** xAI's [Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy) bans "unauthorized automated or non-human" access, and nothing authorises this use. See also the [consumer terms](https://x.ai/legal/terms-of-service). | Allowed under the [enterprise terms](https://x.ai/legal/terms-of-service-enterprise), which cover integrations. |
| **Cursor** (`cursor-agent`) | **Grey area.** There's no specific ban, but Cursor's [Acceptable Use Policy](https://cursor.com/acceptable-use-policy) applies "regardless of how the Service is accessed", bans unauthorised automated access, and passes on the model providers' own policies. See the [Terms of Service](https://cursor.com/terms-of-service). | A Cursor API key works with `cursor-agent`. |

**How to reduce the risk:**

1. **Use API keys where you can.** Switch an agent to **API** in the sidebar, or give its CLI an API key. API use is billed per token, but it's what every provider allows for third-party tools.
2. **Don't use Antigravity with your Google account through Agent Huddle.** Use API mode with a Gemini API key, or switch Antigravity off.
3. **Don't use the cloud version with a Claude subscription token.** Use an `ANTHROPIC_API_KEY` there.
4. **Never share one account with other people** through Agent Huddle, and don't use it to get around usage limits.
5. **Keep a human in the loop.** Use **Ask in chat** rooms, so you approve commands and file changes yourself. Several providers make you responsible for what agents do.
6. If in doubt, **ask the provider** in writing whether this use is OK for your plan.

By using Agent Huddle you accept that **you are responsible for following each provider's terms**, and that the authors aren't liable for any account action, cost or loss. See [Licence and disclaimer](#licence-and-disclaimer).

---

## What it does

- **One room, many agents.** Chat with Claude, Codex, Grok, Cursor and Antigravity together. Type `@claude`, `@codex` and so on to address one, or `@all` / **Ask everyone** for a round-table where each answers in turn and sees the replies before it.
- **Agents hand work to each other.** An agent can @mention another (`@codex can you review this?`) and that agent picks it up. Limits stop runaway loops.
- **Approve from the chat.** In **Ask in chat** rooms, Claude and Codex ask before running a command or changing a file, and you get **Approve / Deny** buttons on the message. Rooms can instead be **Auto-approve** or **Read-only**.
- **See who said what.** Every agent reply shows who asked for it (**← You**, or **← Claude · hand-off**). Tap it to jump to that message. Each approval request on a message shows whether you allowed it, denied it or didn't answer.
- **Rules.** Set rules for one room or for every room, for all agents or for one agent ("Codex never edits tests"). Agents get them at the top of their instructions, marked as more important than anything in the chat.
- **Repos and branches.** Connect a GitHub repo to a room. With **Allow edits** on, agents work in it, and their changes are committed and pushed to the room's own branch, never `main`.
- **Images.** Paste or drop screenshots into a message; agents can open them.
- **Several accounts per agent.** Add a second Claude, Codex or Grok login (for example `@claude-work`) as its own agent, with its own usage.
- **Usage at a glance.** See how much of each plan's 5-hour and weekly limits you've used, where the CLI reports it.
- **Model picker.** Choose the model per agent, including every current Claude model.
- **Phone access.** Pair your phone by QR code, pick up any room on the go, and get **notifications** when an agent needs your approval. The connection is end-to-end encrypted.
- **Private by design.** Your chats, images and settings are stored on your Mac in an encrypted database. Agents run in a macOS sandbox.

---

## How it works

### The Mac app (recommended)

```
┌─────────────────────────────── Your Mac ───────────────────────────────┐
│                                                                        │
│  Agent Huddle.app (Swift + WebKit window, menu bar, Keychain, Sparkle) │
│     │ starts, passes secrets over a pipe                               │
│     ▼                                                                  │
│  local/start.mjs ── launcher (bundled Node.js), keeps the parts below  │
│     │                running, picks free ports on 127.0.0.1             │
│     ├─► local/server.mjs   chat server: the same code as the cloud      │
│     │                      Worker, with an encrypted SQLite database    │
│     │                      (SQLCipher) and WebSockets                   │
│     ├─► container/runner.mjs   runs agent jobs: each CLI in a macOS     │
│     │                          sandbox, in the room's folder; git;      │
│     │                          the login console; usage and models      │
│     └─► local/link.mjs (inside the server)  optional phone access       │
│                                                                        │
│  claude · codex · grok · cursor-agent · agy   (installed and signed    │
│                                                 in by you)              │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ each CLI talks straight to its own provider
                                ▼
              Anthropic · OpenAI · xAI · Cursor · Google
```

1. You send a message. The server works out who should answer: the agents you @mentioned, the agent you replied to, or your default agent.
2. For each agent it builds a prompt. The prompt contains the room's recent conversation, the rules that apply to that agent, what the room's repo is, and how hand-offs work.
3. The runner starts that agent's CLI in the room's folder (for example `claude -p …` or `codex exec …`), inside a macOS sandbox, and streams its activity into the chat.
4. If the agent asks to run a command or change a file in an **Ask in chat** room, the request appears on its message as **Approve / Deny**, and on your phone as a notification.
5. When the agent finishes, its reply is posted. If it @mentions another agent, that agent is queued next. With **Allow edits** on, its changes are committed and pushed to the room's branch.

### The cloud version

The same app also runs on Cloudflare: a Worker, a Durable Object, and a Linux container that runs the CLIs. It works with your Mac switched off. See [The cloud version](#the-cloud-version-cloudflare). It needs a Workers Paid plan, and **should be used with API keys** (see the [terms risks](#terms-of-service-risks)).

### Phone access

```
Phone (browser / home-screen app)  ⇄  Relay (Cloudflare Worker)  ⇄  Your Mac
        └──────────── end-to-end encrypted: the relay can't read it ────────────┘
```

Your phone and your Mac swap keys when you scan a QR code on the Mac. After that, everything between them is encrypted with those keys: pages, messages, images and notifications. The relay only passes encrypted data along. It's described under [Phone access](#phone-access).

---

## Requirements

**Mac app**

- macOS 12 Monterey or later, on Apple Silicon or Intel. The build is for the architecture of the Mac you build on.
- Xcode or the Command Line Tools (`xcode-select --install`), to build the app.
- An internet connection for the first build. It downloads Node.js, Sparkle and cloudflared, about 150 MB, and caches them.
- The agents you want to use, installed. You can install them from inside the app.
- Optional: an **Apple Developer ID** certificate, so the app opens on other people's Macs without warnings. You don't need one for your own Mac.

**Cloud version:** a Cloudflare account on the **Workers Paid** plan (Containers need it).

**Phone access:** any modern phone browser. Notifications need iOS/iPadOS 16.4 or later with the app added to the Home Screen, or Android Chrome. You also need either the hosted relay or [your own](#running-your-own-phone-relay).

---

## Quick start (Mac)

```bash
xcode-select --install                 # once, if you don't have Xcode or its command-line tools
git clone <this repository> agent-huddle
cd agent-huddle/macos
./build.sh --install
```

`build.sh` compiles the app, downloads and bundles Node.js and the server's two npm packages, adds Sparkle and cloudflared, and signs everything. It signs with your Developer ID if you have one, otherwise just for this Mac. Then it copies the app to `/Applications` and opens it. Expect up to three password prompts the first time. Enter your Mac login password and click **Always Allow**: they're for signing and for the key used to sign updates.

When the app opens:

1. **Welcome screen:** enter your name, tick the agents you use, and agree to the terms.
2. **Install agents:** go to **Accounts → Console**, choose **Install on this Mac**, and install the ones you want. *Check which agents are installed* shows what's there.
3. **Sign in, ideally with API keys:** see [Installing and signing in](#installing-and-signing-in-to-the-agents).
4. **Chat:** in the *General* room, send `@claude say hello`.

Updating: pull the latest code, then run `./build.sh --install` again. Your rooms and settings are kept.

---

## Installing and signing in to the agents

Each agent can run in one of two modes, switched with **CLI / API** on its card in the sidebar.

- **CLI mode** runs the provider's own command-line agent. It can read and edit files and run commands, so it can do real coding work.
- **API mode** calls the provider's API directly with an API key, billed per token. It answers questions but doesn't run tools.

**Safest setup:** CLI mode signed in with an **API key**, or API mode. Subscription logins are covered by the [terms risks](#terms-of-service-risks).

| Agent | Install (Accounts → Console) | Sign in with an API key (recommended) | Sign in with a subscription (see risks) |
| --- | --- | --- | --- |
| **Claude** (`claude`) | *Install Claude Code* | Add `ANTHROPIC_API_KEY` in **Accounts → API keys**, or run `claude` in Terminal and choose API key login. | **Accounts → Sign in → Claude**, or `claude auth login`. |
| **Codex** (`codex`) | *Install Codex* | In Terminal: `printenv OPENAI_API_KEY | codex login --with-api-key`, or add `OPENAI_API_KEY` for API mode. | **Accounts → Sign in → Codex** opens your browser (`codex login`). |
| **Grok** (`grok`) | *Install Grok* | Add `XAI_API_KEY` (API mode). | **Accounts → Sign in → Grok** (`grok login --device-auth`). |
| **Cursor** (`cursor-agent`) | *Install Cursor* | Add a Cursor API key as `CURSOR_API_KEY`. | `cursor-agent login` in the console. |
| **Antigravity** (`agy`) | *Install Antigravity* | **API mode** with `GEMINI_API_KEY`. | **Not recommended**; see the risks. |

**The sign-in guide.** **Accounts → Sign in → Sign in to …** runs the CLI's login for you in three steps. It starts the sign-in, sends you to approve it in your browser, and checks that it worked. If a CLI opens your browser itself, click **I've signed in** once you've finished. **Show details** opens the console with the CLI's own output.

**The console** (**Accounts → Console**) is a small terminal. Pick a preset or type a command, and use the keys below it (Enter, arrows, Tab, Esc, Ctrl-C) for interactive prompts. Presets:

| Preset | Runs |
| --- | --- |
| Check which agents are installed | `command -v claude codex agy grok cursor-agent git` |
| Install Claude / Codex / Antigravity / Grok / Cursor | Each provider's official installer. Codex installs into `~/.agenthuddle/npm`. |
| Claude sign-in / status | `claude auth login` / `claude auth status --text` |
| Codex sign-in / status | `codex login` on a Mac (`codex login --device-auth` in the cloud) / `codex login status` |
| Antigravity | `agy` (its interactive screen) |
| Grok sign-in | `grok login --device-auth` |
| Cursor sign-in / status | `cursor-agent login` / `cursor-agent status` |
| Bash | A shell. On the Mac it runs as you. |

**More accounts.** **Accounts → Sign in → More accounts** adds another Claude, Codex or Grok login as a separate agent, for example *Claude (work)*, which you mention as `@claude-work`. Each keeps its login in its own folder under `~/.agenthuddle/accounts/<name>`: `CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex, and its own home folder for Grok. Antigravity and Cursor keep their logins in the system Keychain under fixed names, so they're one account each.

---

## Using Agent Huddle

### Rooms and messages

- **Rooms** (sidebar → **+ New**) each have their own conversation, folder, optional repo, approval mode and rules. Rename a room by clicking its name.
- **Who answers:**
  - Agents you **@mention** answer.
  - With no mention, the agent whose message you're **replying to** answers (**↩ Reply** on a message).
  - Otherwise, your **default agent** answers. Change it under **Accounts → Advanced**.
  - Aliases work too, for example `@agy` or `@gemini` for Antigravity.
- **`@all` / Ask everyone:** a round-table. Each switched-on agent answers in turn and sees the replies before it.
- **Hand-offs:** when an agent's reply @mentions another agent, that agent is asked next. Two limits stop loops: the **hand-off limit** (default 3 in a row) and **replies per message** (default 8). Both are in **Accounts → Advanced**.
- **Images:** attach with the paperclip, paste, or drag and drop. They're saved into the room's folder so agents can open them.
- **Stop** cancels everything queued or running in the room. **Clear** deletes the room's messages and their history; it's under the **⋯** button on phones.
- **Activity log:** under each agent reply, it shows what the CLI did, including commands, files and errors. It's useful when something goes wrong.

### Repos, branches and editing

In the room's settings bar (**⋯** on phones):

1. Enter a GitHub repo (`owner/repo` or an https URL) and, optionally, a branch, then click **Set**. The default branch is `agent-huddle/<room-name>`.
2. **Allow edits off:** agents can read the code but not change it. Any changes are thrown away afterwards.
3. **Allow edits on:** agents edit files and run commands. After each reply their changes are committed (as the git name and email in **Accounts → Advanced**) and pushed to the room's branch. Agents never push to `main`.

For private repos, add a GitHub token in **Accounts → API keys** (`GITHUB_TOKEN`). Use a fine-grained token with **Contents: read and write**, plus **Pull requests** if you want agents to open PRs. The token is used by the runner's git for cloning and pushing; it isn't passed to the agents.

### Approval modes

Each room has an approval mode, set in its settings bar:

| Mode | Claude | Codex | Grok, Cursor, Antigravity |
| --- | --- | --- | --- |
| **Ask in chat** (default) | Asks before every command or file change; you get **Approve / Deny** on the message. | Asks before every command or file change. It runs through `codex app-server` with a read-only sandbox and the `untrusted` policy. | Can read and answer, but don't run commands. |
| **Auto-approve** | With **Allow edits** on, acts without asking. Without edits, it only reads (plan mode). | With **Allow edits** on, acts without asking. Without edits, it uses a read-only sandbox. | Act without asking; in rooms without edits, any changes are thrown away. |
| **Read-only** | Plan mode: looks and answers only. | Read-only sandbox. | Read-only; any changes are thrown away. |

Approval requests also arrive as **notifications** on your Mac and on paired phones. A request you don't answer before the agent finishes or stops is marked as unanswered.

### Rules

Click **Rules** in a room:

- **This room:** rules for that room only. Agents never see them in other rooms.
- **Every room:** global rules, followed everywhere alongside each room's own rules.
- Each rule is for **All agents** or **Only** one agent, for example `@codex`. An agent only gets the rules meant for it.

Rules go at the top of each agent's instructions, marked as coming from you and outranking anything in the chat, including requests from other agents. Claude also gets them as its system prompt, and Codex as its developer instructions. Adding or removing a rule posts a line in the chat. **Rules are instructions, not locks.** For hard limits, also use **Ask in chat** or **Read-only**.

### Who said what

- Each agent reply shows **← who asked**:
  - **← You** for your own message;
  - **← Claude · hand-off** when another agent asked;
  - **Ask everyone** or **default agent** when that's how it was chosen.
- Tap it to jump to the asking message.
- Under the reply, each approval request is listed as **✓ Allowed**, **✕ Denied** or **– Not answered**, with the command or files.

### Models and usage

- **Model picker** (on each agent's card): *Default (CLI decides)*, the models that agent offers, or **Other model…** for any ID.
  - **Claude** lists shortcuts (best, opus, sonnet, haiku, fable, opusplan), then the current and earlier models. With an `ANTHROPIC_API_KEY` set, it uses Anthropic's live model list instead.
  - **Codex** and others list what their CLI reports.
- **Usage** (sidebar → **Usage**) shows each plan's 5-hour and weekly limits where the CLI reports them: Claude via `/usage`, Codex via its app-server, Grok via its billing endpoint, Antigravity via `/quota`. "Couldn't read" means the CLI didn't answer; hover over it for the reason. It doesn't mean you're signed out.

### Mac menu (Agent Huddle)

| Item | What it does |
| --- | --- |
| Check for Updates… | Checks for a new version (Sparkle). |
| Run Agents on This Mac / Use the Cloud Version / Cloud Address… | Switches between the built-in server and a cloud deployment. |
| Restart Agents | Restarts the server and the runner. |
| Sign In Again | Retries the automatic sign-in to the built-in server. |
| Keep Mac Awake While Plugged In | Stops the Mac sleeping while the app runs on power (on by default). |
| Contain Agents (Sandbox) | Runs each agent in a macOS sandbox (on by default). |
| Phone Access… | Opens **Accounts → Phone**. |
| Own Relay (Advanced)… | Uses your own Cloudflare Tunnel instead of the relay. |
| Open Agent Huddle Folder | Opens `~/Library/Application Support/Agent Huddle`, which holds `logs/`, `work/` and so on. |

Closing the window keeps Agent Huddle and your agents running; click the Dock icon to bring it back. Quitting stops everything.

---

## Phone access

### Setting it up

1. On the Mac, go to **Agent Huddle → Phone Access…** (or **Accounts → Phone**).
2. Create an account with your email and a password of at least 10 characters. Open the confirmation email, then click **Sign in** in the app.
3. Click **Pair a phone**. Scan the QR code with your phone's camera and tap **Pair**. The code works once, for 10 minutes.
4. Your rooms open on the phone. Next time, just open the relay's address (for example `https://app.agenthuddle.net`) and pick your Mac.

To install it as an app, open the relay address in Safari and choose **Share → Add to Home Screen** (or **⋮ → Install app** in Chrome). **Notifications:** under **Your Macs**, tap **Turn on**. On iPhone this only works from the Home Screen app. On the Mac, **Accounts → Phone → Notifications** chooses when to notify: approvals only (the default), approvals and every reply, or never. A phone that has the app open right now isn't notified.

The **Mac must be awake with Agent Huddle open** for your phone to reach it. *Keep Mac Awake While Plugged In* helps.

### How it's protected

- **Pairing:**
  - The QR code carries a one-time secret and the Mac's public key, in the part of the link after `#`, which is never sent to the relay.
  - The phone makes its own key pair and proves it saw the code (HMAC with the secret), so the relay can't pair a device itself.
  - The phone's private key is stored in its browser and can't be exported.
- **Each session:** ECDH (P-256) between the two devices' long-term keys plus fresh random values from both sides → HKDF → a separate AES-256-GCM key for each direction. Every frame carries a counter that must go up by one, so the relay can't replay, reorder or silently drop anything.
- **Notifications:** the Mac encrypts each notification for one paired phone, using a key derived from the pairing. The relay wraps it as a standard Web Push message (RFC 8291, with VAPID), and your phone's service worker decrypts it. Neither the relay nor Apple, Google or Mozilla can read it.
- **The relay keeps:** your email (and whether it's confirmed), a salted PBKDF2 hash of your password, your Macs' names, sign-in sessions, recent failed sign-in attempts, single-use email links (hashed), and the push addresses of devices with notifications on. You can delete the account from the phone under **Manage → Delete account**.
- **Accounts:** you confirm your email before linking a Mac. An address nobody confirmed can be claimed by its real owner. Password reset is by an emailed link, and the answer is the same whether or not an account exists. A reset signs out every other device; your Macs stay linked.
- **Removing a phone** on the Mac (**Accounts → Phone**) cuts it off at once.

The project's hosted relay is `app.agenthuddle.net`. Using it means trusting that service with the account details listed above, though never with your chats. You can [run your own relay](#running-your-own-phone-relay) instead, and point the Mac app at it with `AH_RELAY_URL`.

**Own Relay (Advanced):** instead of the relay, you can put the Mac's server on a Cloudflare Tunnel to your own address. That way you sign in with the app password (copied to your clipboard when you save) rather than pairing. It uses a password instead of end-to-end pairing, so only use it if you know why you want it.

---

## Security and privacy

**What's protected**

- **Encrypted at rest:** messages, images, settings and saved keys are in an SQLCipher database encrypted with a 256-bit key. That key, the app's password and the runner secret are in your **login Keychain**. They reach the background processes over a pipe, never in files, command arguments or environment variables. If the Keychain refuses (it can, after a rebuild without a Developer ID), they're kept in a private file (`secrets.json`, mode 0600) in the app's folder instead.
- **Local only:** the server and runner listen on `127.0.0.1`. The window signs in automatically with a random password, which stops other apps and websites on your Mac from using your agents. Write requests also need a custom header and a same-origin check.
- **Agents are sandboxed** (`sandbox-exec`). An agent can write only to its room's folder, temporary folders and its own settings folders. It can't read Agent Huddle's data, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `gh`'s login, or the browser cookie stores.
- **Logins stay with the CLIs.** On the Mac, each CLI keeps its own login where it always does. Agent Huddle doesn't copy or read those tokens.
- **Your data goes nowhere else.** Agents talk straight to their providers under your accounts. Nothing passes through this project except the optional, encrypted phone relay.

**What isn't protected**

- **Files in a room's folder** aren't encrypted by Agent Huddle, because agents need to read them. The same goes for each CLI's own login files and Keychain items.
- **What you approve.** In **Auto-approve** rooms, or with the sandbox off, an agent can do anything your user account can do in its folder. Only turn edits and auto-approve on for repos you're happy for agents to change.
- **What providers do with your prompts.** Everything an agent reads is sent to its provider under that provider's terms and privacy policy. Some providers review conversations.

Found a security problem? See [Contributing](#contributing): please report it privately.

---

## Configuration reference

### Settings (Accounts → Advanced)

| Setting | Default | Meaning |
| --- | --- | --- |
| Your name | (asked at first run) | What agents call you. |
| Default agent | `claude` | Who answers messages with no @mention. |
| Hand-off limit (`maxHops`) | 3 | Most agent-to-agent hand-offs in a row. |
| Replies per message (`maxRunsPerTurn`) | 8 | Most agent replies one message of yours can trigger. |
| Timeout (`timeoutSec`) | 1200 | Longest a single agent reply may run, in seconds. |
| History sent (`historyChars`) | 40000 | How much of the room's conversation goes into each prompt. |
| Git name / email | (none) | Author used for agents' commits. |

### Agent definitions

**Accounts → Advanced → Agent commands** is the list of agents as JSON. You can change it without rebuilding, which helps if a CLI changes its flags. Each agent:

```jsonc
{
  "id": "codex",                 // used for @mentions; lowercase letters, digits, - or _
  "name": "Codex",
  "color": "#10a37f",
  "aliases": ["gpt"],            // extra @names (optional)
  "enabled": true,
  "mode": "cli",                 // "cli" or "api"
  "note": "Shown on the card",   // optional
  "login": { "command": "codex login", "files": [".codex/auth.json"] },
  "cli": {
    "command": "codex",
    "args": ["exec", "--skip-git-repo-check", "--color", "never", "--output-last-message", "{outfile}"],
    "modelFlag": "-m", "model": "",
    "readArgs": ["--sandbox", "read-only", "-"],                         // Auto-approve rooms without edits
    "editArgs": ["--dangerously-bypass-approvals-and-sandbox", "-"]      // Auto-approve rooms with edits
  },
  "api": { "provider": "openai", "model": "gpt-5", "keyEnv": "OPENAI_API_KEY" }  // or null
}
```

- **Placeholders:** `{prompt}` and `{model}` are filled in by the server; `{outfile}` and `{workspace}` by the runner. If `args` doesn't contain `{prompt}`, the prompt is sent on stdin.
- **API providers:** `anthropic`, `openai` (also any OpenAI-compatible API through `baseUrl`, as for Grok) and `gemini`.
- **Ask in chat / Read-only** arguments are added by the app: `--permission-prompt-tool` for Claude, and `codex app-server` for Codex.
- **Reset** returns to the defaults.

### Keys (Accounts → API keys)

| Name | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude in API mode; Claude's live model list |
| `OPENAI_API_KEY` | Codex / OpenAI in API mode |
| `GEMINI_API_KEY` | Antigravity in API mode (Gemini) |
| `XAI_API_KEY` | Grok in API mode |
| `CURSOR_API_KEY` | Cursor CLI |
| `CLAUDE_CODE_OAUTH_TOKEN` | Cloud version only. **Don't use it with a subscription token** (see the risks). |
| `GITHUB_TOKEN` | git clone and push for room repos (cloud version) |

Keys are never sent back to the browser. It only learns whether each one is set.

### Environment variables

| Variable | Where | Meaning |
| --- | --- | --- |
| `AGENT_HUDDLE_HOME` | `local/start.mjs` | Data folder. Default `~/Library/Application Support/Agent Huddle` on a Mac, `~/.agenthuddle-local` elsewhere. |
| `AGENT_HUDDLE_PORT` | `local/start.mjs` | First port to try (default 18787; the runner uses the next one). If the ports are busy, the next free pair is used. |
| `AH_RELAY_URL` | `local/start.mjs` | Phone relay address (default `https://app.agenthuddle.net`). |
| `AH_DEBUG` | `local/start.mjs` | Extra logging (notifications). |
| `APP_PASSWORD` | Cloud Worker secret | The password for the cloud version. |
| `DEV_RUNNER_URL` | `wrangler dev` | Use a runner on your machine instead of a container. |

### Files and folders (Mac)

| Path | Contents |
| --- | --- |
| `~/Library/Application Support/Agent Huddle/state/` | Encrypted database (`agenthuddle.db`) and private state |
| `…/work/` | Each room's folder (repos, attachments) |
| `…/logs/` | `server.log`, `runner.log`, `relay.log` |
| `…/app/` | Copy of the app's server code (refreshed after each update) |
| `…/config.json` | Non-secret settings (keep awake, sandbox, relay address) |
| `~/.agenthuddle/accounts/<name>/` | Extra accounts' CLI logins |
| `~/.agenthuddle/npm/` | Codex installed by the app |
| Keychain item **Agent Huddle** | Database key, app password, runner secret, relay token |

---

## The cloud version (Cloudflare)

Runs the whole thing on your own Cloudflare account, so it works with your Mac off. **Use API keys here.** Pasting a Claude subscription token (`claude setup-token`) into a hosted service is against Anthropic's terms, and the same caution applies to the others. See the [risks](#terms-of-service-risks).

```
Phone / browser ──► Worker (password sign-in, serves the app)
                       │
                       ▼
                 Durable Object "Hub" ── rooms, messages, settings, saved keys; live updates (WebSockets)
                       │
                       ▼
                 Container (Linux) ──── runs the CLIs, clones and pushes repos; sleeps after 15 min idle
```

**Deploy from GitHub** (no Docker needed):

1. Fork or push this repo to your GitHub account.
2. In Cloudflare: **Workers & Pages → Create → Import a repository**. Keep the project name **`agentroom`** (it must match `wrangler.jsonc`) and the deploy command `npx wrangler deploy`.
3. In the Worker's **Settings → Variables and Secrets**, add a secret `APP_PASSWORD`. Make it long: anyone with it can use your agents.
4. Open `https://agentroom.<your-subdomain>.workers.dev`, sign in, and add your API keys under **Accounts → API keys**.

**Deploy from a computer** (needs Docker running): `npm install && npx wrangler login && npx wrangler deploy && npx wrangler secret put APP_PASSWORD`.

**How it behaves:**

- The container sleeps after 15 minutes idle; the next message wakes it in a few seconds.
- Logins and keys are saved in the Durable Object and restored when it wakes.
- The container's disk is wiped while it sleeps. With **Allow edits** on, work is committed and pushed, so nothing is lost.

For extra protection, put **Cloudflare Access** in front of the Worker (Zero Trust → Access → Applications) to require an email one-time code.

---

## Running your own phone relay

The relay is a small Cloudflare Worker in `relay/`. Accounts are stored in Durable Objects, emails go out through Cloudflare Email Service, and notifications through Web Push.

1. In `relay/wrangler.jsonc`, set your sender address in `send_email` and your own `VAPID_PUBLIC` / `VAPID_SUBJECT`. Onboard your domain for sending under **Cloudflare → Email Service** first.
2. Make a VAPID key pair (P-256 ECDSA). Put the public key, base64url of the raw 65-byte key, in `VAPID_PUBLIC`. Set the private key as a secret:
   ```bash
   cd relay
   npx wrangler secret put VAPID_PRIVATE      # the private key as a JWK JSON string
   ```
   Any Web Push library can make the pair, for example `npx web-push generate-vapid-keys`. Convert the private key to JWK (`kty: EC, crv: P-256, x, y, d`).
3. Build and deploy:
   ```bash
   node build.mjs          # bundles the phone web app, icons and policies into pages.js
   npx wrangler deploy
   ```
   Then attach your domain to the Worker. You can also connect the repo with **Workers Builds**: root `relay`, build command `node build.mjs`, deploy command `npx wrangler deploy`.
4. On the Mac, start Agent Huddle with your relay. For a one-off test, run `AH_RELAY_URL=https://your-relay.example node local/start.mjs`. For the app itself, change the default in `local/server.mjs` and rebuild.

For local testing, `npx wrangler dev --port 8790 --local` in `relay/`, with a `.dev.vars` file holding test VAPID keys, `DEV_PUSH_ORIGIN=http://127.0.0.1:8799` (to allow a fake push service) and `RATE_LIMIT_OFF=1`. Emails are then written to files instead of being sent, and the log shows where.

---

## Building and releasing the Mac app

```bash
cd macos
./build.sh              # build into macos/build/
./build.sh --install    # build, copy to /Applications and open it
./build.sh --release    # build, sign with your Developer ID, notarise, and make a .dmg
./publish.sh            # after --release: publish the .dmg as an automatic update
```

**What `build.sh` does:**

1. Compiles `main.swift` against Sparkle.
2. Builds the login console's terminal helper (`ahpty.c`).
3. Bundles the latest Node.js 22 and the server code, and installs `better-sqlite3-multiple-ciphers` and `ws` from their prebuilt binaries.
4. Adds cloudflared.
5. Writes the version: `macos/VERSION` for people, the git commit count for Sparkle.
6. Signs every executable and Sparkle's helpers, then the app. It uses your **Developer ID Application** certificate (with the hardened runtime) if you have one, otherwise it signs ad-hoc for this Mac only.

**Releasing** (one-time setup):

1. Install a **Developer ID Application** certificate. In Xcode: Settings → Accounts → Manage Certificates → + → Developer ID Application. Or create one at [developer.apple.com](https://developer.apple.com/account/resources/certificates/list).
2. Make an app-specific password at [account.apple.com](https://account.apple.com), then run `xcrun notarytool store-credentials AgentHuddle --apple-id you@example.com --team-id TEAMID`.
3. Sign in to Cloudflare for uploads: `"build/Agent Huddle.app/Contents/Resources/node/bin/npx" wrangler login`.

**Then, for each release:**

1. Change `macos/VERSION` and commit.
2. Run `./build.sh --release`, then `./publish.sh`.

`publish.sh` keeps every release in `macos/releases/`. It has Sparkle's `generate_appcast` sign them with your EdDSA key and write `appcast.xml`, then uploads both to the `agenthuddle-updates` R2 bucket, which is served at `updates.agenthuddle.net`.

**The update-signing key** is made in your Keychain on the first build. Copies already released only accept updates signed with it, so back it up:

```
~/Library/Caches/AgentHuddleBuild/Sparkle-*/bin/generate_keys -x key.txt
```

Store that in a password manager. To restore it on another Mac, run the same command with `-f key.txt`.

**Forking and publishing your own build?** Change the bundle ID (`BUNDLE_ID=… ./build.sh`) and the Sparkle feed (`SUFeedURL` in `macos/Info.plist`). Use your own update key, bucket and domain in `publish.sh`, and your own relay address. Otherwise your copies would try to update from, and connect through, this project's servers.

---

## Project structure

```
src/                 The chat server (Cloudflare Worker + Durable Object "Hub"); runs unchanged on the Mac
  index.js           Rooms, messages, routing, prompts, rules, approvals, record, usage, the HTTP/WebSocket API
  agents.js          Default agents, settings, console commands, approval arguments, validation
public/              The web app: index.html (everything), login.html, service worker, terms and privacy pages
container/           The agent runner (Node), used in the cloud container and on the Mac
  runner.mjs         Jobs, workspaces and git, the macOS sandbox, approvals, the login console
  codex-app.mjs      Codex through `codex app-server` (approvals in chat)
  approve-mcp.mjs    Claude's permission-prompt tool (approvals in chat)
  usage.mjs          Plan usage and model lists per CLI
  users.mjs, keyring.mjs   Per-agent users and keyring in the cloud container
  Dockerfile         The container image (CLIs installed)
local/               The Mac's server side
  start.mjs          Launcher: secrets from the app, free ports, keeps server and runner running
  server.mjs         Runs src/ in plain Node with encrypted SQLite and WebSockets
  link.mjs           Phone access: relay connection, pairing, encrypted channel, notifications
  tunnel.mjs         The end-to-end encryption shared by the Mac, the phone and the service worker
macos/               The Mac app: main.swift, Info.plist, build.sh, publish.sh, ahpty.c, icon, entitlements
relay/               The phone relay Worker: worker.js, push.js (Web Push), shell.html (phone app), sw.js
site/                Draft website for agenthuddle.net (not published)
legal/               Terms and privacy policy in Markdown; build.py writes public/*.html
wrangler.jsonc       Cloud deployment (Worker, Durable Object, container)
```

---

## Development and testing

```bash
npm install

# The Mac server without the app (any OS with Node 22+). Prints READY {"url": …}.
node local/start.mjs
# The dev password is in <data folder>/state/dev-secrets.json.

# The cloud Worker against a local runner, no container:
echo 'APP_PASSWORD=dev' > .dev.vars
PORT=8099 node container/runner.mjs &
npx wrangler dev --enable-containers=false --var DEV_RUNNER_URL:http://127.0.0.1:8099

# The relay:
cd relay && node build.mjs && npx wrangler dev --port 8790 --local

# Point the Mac server at the local relay:
AH_RELAY_URL=http://127.0.0.1:8790 node local/start.mjs
```

- Changes to `legal/*.md` need `python3 legal/build.py`.
- Changes to the phone app or `local/tunnel.mjs` need `node relay/build.mjs`.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `build.sh`: *unbound variable* | Update to the latest code. Older versions tripped over macOS's built-in bash 3.2. |
| The app shows a sign-in page or *Wrong password* | Another copy (for example an older build, or "Agent Room") is still running. Quit it from the Dock, run `pkill -f local/start.mjs`, then **Agent Huddle → Restart Agents** or **Sign In Again**. Newer versions pick free ports automatically. |
| A grey macOS window asks for a password | That's the Keychain asking whether the new build can read its saved secrets. Enter your Mac login password and click **Always Allow**. Builds without a Developer ID count as a new app each time. |
| Console: `tcgetattr/ioctl: Operation not supported on socket` | Update. The app now uses its own terminal helper (`ahpty`) instead of macOS's `script`. |
| Codex sign-in: *authentication required to read rate limits* | The sign-in didn't finish. On a Mac, Codex now signs in through your browser. Device-code sign-in also needs device-code login turned on in ChatGPT's security settings. Check with `codex login status`. |
| Antigravity sign-in waits forever | If Antigravity opens straight to its chat screen, it's already signed in. Click **Stop**, or **I've signed in**. Remember the [risks](#terms-of-service-risks). |
| An agent shows *sign in* but works | A failed usage read used to count as signed out. Update. Hover over "Usage: couldn't read" for the reason. |
| An agent fails with a sandbox or permission error | It may need to write outside its folder. Turn off **Agent Huddle → Contain Agents (Sandbox)** to check, then report which folder it needed. |
| An agent's command line changed | Edit **Accounts → Advanced → Agent commands**. The activity log shows the CLI's own error. |
| My phone says the Mac is offline | The Mac must be awake with Agent Huddle open and online. Check **Accounts → Phone** shows *connected*. |
| No notifications on iPhone | They need the Home Screen app (iOS 16.4+), notifications allowed, and **Turn on** under Your Macs. The app mustn't be open at the time. |
| Where are the logs? | **Agent Huddle → Open Agent Huddle Folder → logs**, plus each reply's activity log. |

---

## FAQ

**Does it cost anything?** Agent Huddle is free. You pay your providers as usual, either per token with API keys or through your plans. The cloud version needs Cloudflare's Workers Paid plan.

**Is my code sent anywhere?** Only to the providers whose agents read it, under your accounts. Nothing goes to this project, apart from the optional, encrypted phone relay, which can't read it.

**Windows or Linux?** The Mac app is macOS only. The server and runner run anywhere Node 22 does (`node local/start.mjs`), without the macOS sandbox or the app's Keychain handling. The cloud version runs on Cloudflare.

**Can I add another agent?** Yes, if it has a CLI that takes a prompt and prints a reply. Add it in **Accounts → Advanced → Agent commands**. Approvals in chat and usage readers are built for the five included CLIs.

**Why do agents need my Mac to be on?** They run on your Mac, with your files and logins. For an always-on setup, use the cloud version, with API keys.

---

## Contributing

Issues and pull requests are welcome. This is a spare-time project, so replies may take a while.

- Keep the **[terms risks](#terms-of-service-risks)** in mind. Changes that read, store or forward providers' login tokens, or that work around usage limits or safety checks, won't be accepted.
- Explain user-facing changes in plain English, and update this README.
- Test the Mac path (`node local/start.mjs`) and, if you touch it, the relay (`wrangler dev`).
- **Security issues:** please report them privately to hello@agenthuddle.net rather than in a public issue.

---

## Licence and disclaimer

Licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE).

The software is provided **"as is", without warranty of any kind**, as set out in the licence. You're responsible for how you use it: following each AI provider's terms and policies, keeping your accounts and keys secure, the actions you let agents take, your costs, and backups of your work. The authors and contributors aren't liable for any account suspension, charges, data loss or other damage arising from its use.

Claude and Claude Code are trademarks of Anthropic. Codex, ChatGPT and OpenAI are trademarks of OpenAI. Grok and xAI are trademarks of their owners. Cursor is a trademark of Anysphere. Google, Gemini and Antigravity are trademarks of Google. Agent Huddle is an independent project and isn't affiliated with or endorsed by any of them.
