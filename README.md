# Screddy

A macOS coding-agent workspace based on [T3 Code v0.1.9](https://github.com/pingdotgg/t3code/releases/tag/v0.1.9). Use your existing Codex, Claude Code, or other supported agents to work across projects, terminals, Git worktrees, and diffs. The upstream [MIT license](./LICENSE) applies.

## Download for Apple Silicon

Get the DMG or ZIP from [Screddy Releases](https://github.com/Screddyice/screddys-ide/releases/latest). Download new versions from the same page.

## Configure Mission Control

Mission Control reads optional account and workspace bindings from `~/.screddys-ide/mission-control.json` on the Mac running Screddy. Add your own Composio connection selectors for Google Tasks (`tasks`), Linear (`linear`), Slack (`slack`), and NEBOS (`nebos`). To complete issues in Linear, also set `linearEmail` to the connected account's email. **Mark complete** then moves a Linear issue assigned to you to its team's completed status, and marks a Google Tasks item completed through the `tasks` connection. Each one is confirmed with the provider before the row disappears; without `linearEmail`, Linear issues show an error instead of completing.

With a `tasks` connection, **Add task** next to **Refresh** (on the **All** and **Personal tasks** views) adds a task to your default Google Tasks list, and **Edit** on a Google Tasks row changes its title, notes or due date. An edit sends only the fields you changed, so a newer change made in Google Tasks is not overwritten. Google Tasks must confirm the saved values; if it does not reply, Screddy reads the task back before reporting a failure, and asks you to check Google Tasks before adding a task again.

The packaged macOS app also serves Mission Control on a private socket, `sockets/mission-control.sock` inside Screddy's base folder (`~/.screddys-ide` by default). The folder is owner-only and the socket accepts only your user. The app opens it at startup and removes it on quit. It answers three requests from the Screddy server on the same Mac: the priorities list, an email reply preview, and the actions above. It accepts a reply preview or an action on an existing item only for an unrestricted item that a priorities answer showed in the last 15 minutes, or for a task the caller just added, so a restricted item can't be changed through it even by ID. Apps connected through **Use in another app**, such as ChatGPT and its Dot agents, get three MCP tools on top of it: `mission_control_priorities` reads the ranked list, `mission_control_reply_preview` checks an email before a reply, and `mission_control_act` sends a reply, completes a Linear issue or Google Task, or adds or edits a task. Items Mission Control marks restricted (confidential, regulated data, or your `restrictedTerms`) are withheld from these tools. An app approved for read-only access can read but not act. Agent threads and linked environments never see the tools. Screddy must be running on the Mac; if it isn't, the tools say so.

For workspace routing, `projectRepositories` maps a supported product key such as `nebos` to its GitHub `owner/repo`. Add the corresponding project in Screddy. Set `nebosUrl` to your NEBOS HTTPS origin for source links. An optional `contextFile` or `claudeWorkspaceDir` uses a local absolute path. Set `claudeWorkspaceDir` to the Claude Code config folder your sessions actually use (the `CLAUDE_CONFIG_DIR` you launch Claude with); otherwise **Agent activity** reads only `~/.claude` and misses those sessions. Agent activity counts a Claude Code session as running while it is busy, and its summary strip shows each agent family's running count next to today's tokens, from the same usage report as the menu bar. Set `restrictedTerms` to a list of phrases that should stay out of agent handoff and priority scoring.

Tasks routed to Grok Bot go to one main bot. Set `grokBot` to `{ "botName": "<name>", "url": "grokbot://app/v1/agent?id=<bot id>" }`, using a bot on the account Grok Bot is signed in with; a bot from another account shows "Bot Not Found". **Go to Grok Bot** (shown with the Grok Bot logo) opens that bot with the task typed into its message box, through Grok Bot's `grokbot://app/v1/prompt` link, and then presses Send for you. Grok Bot asks before filling the box until you tick its "Don't show again" option; Screddy waits up to a minute for you to confirm. Screddy presses Send through Cua Driver (`/Applications/CuaDriver.app`) and only when the box holds exactly that task, so it never sends a draft you had already started. It leaves Send to you, and says why, when Cua Driver is not running, when Grok Bot's own computer-use helper is driving the Mac, or when the task does not appear in the box. Grok Bot ignores a link it does not accept, leaving the box empty, so Screddy writes the task on one line (Grok Bot refuses line breaks), removes hidden characters such as emoji variation selectors, and shortens it with "…" to fit both of Grok Bot's limits: 1,000 characters of text and 2,048 characters for the whole link. The rules live in `packages/shared/src/grokBotPrompt.ts` and match Grok Bot 1.2.3. If the bot already has an unsent draft, Grok Bot keeps that draft and does not fill the task.

Switch between **Top priorities** and **Agent activity** with the view dropdown at the top of Mission Control. Changing the view scrolls the page back to the top.

The **Sources** section under the list appears only when a connected source is unavailable, and lists just those sources with the reason. Sources that are connected or partly covered are not listed.

The **Running** tile counts Screddy threads that are working plus agents working outside Screddy that Agent activity can see, such as a busy Claude Code session, and lists both. A thread that has finished its turn says **Ready** and counts under **Needs attention** until you settle it; a settled thread says **Done** and is not counted.

Agent activity reports live state for agents you run outside Screddy on this Mac. A Codex or Grok Build session is **running** while the newest turn in its session log is open and the log was written in the last 10 minutes; a Grok Build session waiting on a permission prompt shows as needing input. A Cursor chat is running while a `cursor-agent` process is working in its folder. Claude Code reports its own state. Cursor cloud agents need `cursorCloud` and `CURSOR_API_KEY`.

The bar at the top of Mission Control shows today's total tokens and the current throughput in tokens per minute. Throughput is the tokens added between the last two usage reads, which happen every minute while Mission Control is open; it says "measuring throughput…" until the second read. The menu bar item is the green logo with today's token total beside it and, from the second usage read a minute later, the throughput, for example `2.73B · 1.20M/min`; nothing shows beside it until the first usage read. Hover it or open its menu for today's tokens with the same throughput, for example `2.73B tokens · 1.20M/min`; usage is re-read every minute while Screddy is open, so a separate speedometer menu bar item is not needed. The bar and Agent activity keep one usage window for as long as they are open; the bar moves to the new day on its next read after midnight.

To connect SRCOS, set `srcosTenant` and the absolute path `srcosCredentialFile`. Store the HTTPS `origin` and access `token` together in that separate JSON file with owner-only permissions (`chmod 600`).

Mission Control routes and prioritizes tasks locally by default. Enter your own OpenRouter API key in the optional JEV onboarding step, or set it up later under **Settings → General → Mission Control**. Screddy verifies JEV and stores the key in encrypted desktop storage. An independently configured `jevCommand` remains available when a saved OpenRouter key is absent. To show Cursor Cloud activity in Screddy, set `cursorCloud` to `true` and supply `CURSOR_API_KEY` to the desktop process through its environment.

## Automations

**Automations** in the sidebar, under Mission Control, opens its own page listing every scheduled task across all projects and environments. Use the scope picker at the top to narrow it to one project or environment. The same list is still under **Settings → Automations**.

On macOS the desktop app can also read every job this Mac runs on its own: launchd jobs (your launch agents and the system-wide agents and daemons, through `plutil` and `launchctl`), `crontab -l` lines and Codex automations in `~/.codex/automations`. For each it reports the schedule in plain words, whether it runs on a timer, stays running, starts at login or runs on demand, the command or script with secret values hidden (after a flag such as `--token`, in an assignment such as `API_TOKEN=…` or `TOKEN=…`, or in a URL query such as `?token=…`, with the parameter name URL-decoded first), and its state (running, ready, failed with its exit code, paused, disabled or not loaded). A launchd entry that sets an hour but no minute reads as every minute of that hour (for example "Daily, every minute 08:00–08:59"), since that is how launchd runs it. Reading changes nothing. These jobs show under **On this Mac** on the Automations page and in **Settings → Automations**, grouped into scheduled, always running, at login and on demand; **Refresh** reads them again.

## Token usage across Claude profiles

The Usage page and the menu bar token count add up Claude Code usage from every Claude profile on the machine: `~/.claude`, any `~/.claude-*` folder, and the folder in the server's `CLAUDE_CONFIG_DIR`. Switching profiles between sessions does not hide earlier usage, and a message stored in two profiles is counted once. A Claude provider with its own home path under **Settings → Providers** adds that home to the count, so pointing chats at another account keeps every profile's earlier usage. A profile kept anywhere else (for example `~/TeamNebula/team-context`) is counted once you add it as a usage account: the `usageAccounts` server setting maps an id to a provider (`claude`, `codex` or `grok`), a label, a home folder (`~` works) and `enabled`. Screddy then reads that home's `projects` folder for Claude, or its `sessions` folder for Codex and Grok, and the Usage page names the folder with the account's label. A folder Screddy already reads, such as `~/.claude`, is still counted once; adding it only gives it a name. Turning an account off stops counting it, and a wrong path shows up as a missing folder rather than an error. Each account is kept as its own entry, so editing one never overwrites another. To add one, open **Settings → Providers → Usage accounts**, click **Add account** and pick the home folder (**Choose…** opens a folder picker). Screddy suggests the app from the folder name (a name containing `codex` or `grok` picks that app; anything else is Claude Code) and a name from the folder, and refuses a relative path or a folder or name that's already added. Each account's row shows its tokens and sessions over the last 30 days, "No projects folder found" when the path is wrong, and a switch to stop counting it without removing it. The Usage page opens with **Right now**, the menu bar's numbers in full and re-read every minute: today's tokens and API-estimate cost, throughput in tokens per minute, this week, the last 30 days with its session count, the top model, today's mix of input, cached, cache-write and output tokens, and each provider's plan with its 30-day tokens. Its **Breakdown** has an **Account** view next to Model and Day: one row per folder Screddy read in the chosen window, busiest first, named by its account (or its home folder, such as `~/.claude`), with sessions, share and tokens or cost. Folders with no usage and no account name are left out, a missing account folder says so, and **Add or manage usage accounts** opens Settings → Providers. The menu bar token menu names the model you used most in the last 30 days at the top, lists providers and their models from most to least used, and shows each provider's signed-in plan. A Claude Max 20x account reads **Ultra**; the tier comes from `claude auth status` for the profile Screddy's Claude provider uses.

## Build and run on Apple Silicon

Use Node 26.12.1, pnpm 12.14.0, Xcode Command Line Tools, and Rust with the `aarch64-apple-darwin` target. From the repository root:

```sh
pnpm install --frozen-lockfile
cp -n .env.example .env
pnpm exec node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version 0.1.9
```

The optional `.env` step includes the upstream public T3 Connect configuration. The local build uses its own app bundle and stores server data in `~/.screddys-ide/userdata` and its macOS browser profile in `~/Library/Application Support/screddys-ide-v2`. Development uses `~/.screddys-ide-dev` by default. To run from source, use `pnpm run dev:desktop --no-seed`.

If a background service (for example a launchd agent with `KeepAlive`) keeps a server running for `~/.screddys-ide` after you quit, opening the app takes over from it, whatever version it runs: the app stops that server, waits for it to exit, and starts its own. If the service restarts its server first and takes the data folder back, the app stops it again and retries, up to four times, before it shows "This T3 home is unavailable". The service starts its server again after you quit the app, on the installed version, so you no longer need to stop it by hand. The app only stops a process its own server entry point started; a server from any other program or install (such as the stock `t3` service) is never touched and still gets that message. With "Local environment" turned off in Settings the app starts no server of its own, so it leaves the background server running. The four retries count again each time the app's server comes up, so a race later in the same session gets them too. The window opens while the app's server is still starting, so after such a retry it reloads once that server is up instead of staying on an error from the background server.

## Continuous integration

Crow CI on Shawn's Mac runs `.woodpecker.yaml` on every push and pull request: the Mission Control and chat tests, on Node 26.12.1 in a Linux arm64 container. The GitHub **Verify Screddy changes** job runs the same tests on every pull request, independently of Crow. A push made while the Mac is asleep or offline gets no Crow run.

Before opening a pull request, run `pnpm exec vp run typecheck` inside the package you changed. `apps/web` passes with no warnings, so a new warning comes from your change.

## Build a preview from main

Run **Package Screddy for Apple Silicon** on the `main` branch in GitHub Actions with a version such as `0.1.42-preview.20261122.1`. The workflow checks Mission Control and chat behavior on pull requests. Builds from `main` attach the DMG, ZIP, and SHA-256 checksums to the workflow run.

## Build a signed release for a private feed

Run **Sign Screddy stable for Apple Silicon** on `main` with the release version, such as `0.1.42`. Set `CSC_LINK` and `CSC_KEY_PASSWORD` for the Developer ID Application signing identity and `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` for notarization in the repository's Actions secrets. Publish the verified DMG, ZIP, blockmaps, `latest-mac.yml`, and `SHA256SUMS` together on the private GitHub release for the exact build commit.

Install the signed stable DMG once and sign in to GitHub CLI on that Mac with access to this repository. Screddy checks the private stable feed automatically and prompts before installing an update.

This repository imports the Screddy source snapshot based on `bb564f6e` and retains the upstream MIT license. The original T3 Code workflows are available under `.github/upstream-workflows` for reference.

## Use Xcode

Open a thread in a local project or worktree and choose **Open in → Xcode**. The IDE looks for a top-level `.xcworkspace`, `.xcodeproj`, or `Package.swift`, in that order. You can also use the editor menu on individual files. Use the integrated terminal for `xcodebuild` and `xcrun simctl` with the full Xcode installation selected.

## Connect the T3 mobile app

1. In Screddy, open **Settings → Sharing & access** and turn on **Network access**.
2. Create a pairing link and select a network address your phone can reach.
3. In the existing T3 Code app for [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code), open **Settings → Environments → Add environment** and scan the QR code or paste the pairing URL.

Keep the IDE running while using its local environment from your phone. Direct pairing works over a shared LAN or a reachable private network such as Tailscale. For the optional hosted route, see the [upstream T3 Connect setup](./docs/user/remote-access.md#t3-connect).

## Use a local model endpoint

- In a coding thread, open the model picker and choose **Add local model**. Enter the URL and exact model ID from your loopback OpenAI-compatible server, then select the saved model. This uses OpenCode on the local environment’s PATH. Enable tool calling only for models that support it.
- For titles, commit messages, and similar text tasks, choose **Settings → Providers → Text generators → Add generator → Custom (OpenAI-compatible)**. Enter the base URL of a running local model server, such as `http://127.0.0.1:11434/v1` for Ollama.

The endpoint is relative to the machine running the IDE environment. Setup is opt-in.

## Split workspace

Use **Split workspace** in a thread header to add a side-by-side pane. Each pane can show another existing thread. A diff opened from a split pane appears as a sheet on the right.

For contributors: the chooser button is `SplitPaneThreadSelector` and the searchable thread list is `SplitThreadPicker`, so every pane shares one implementation.

The first pane's thread chooser sits in that pane's own header. The eye button beside it hides the chooser and brings it back; hiding it leaves every pane's chat and draft as they were. On the desktop app that header is still the window title bar, so you can drag the window by it and it stays clear of the window controls when the sidebar is collapsed.

## Thread status in the sidebar

A thread that is setting up or working shows a spinning blue ring in the sidebar, in the same blue the working icon used before. Threads waiting on you or on another thread keep their own icons.

## Appearance

The sun or moon button in the sidebar footer switches between light and dark mode. The same button sits beside **Split workspace** in the thread header. A theme that has only one mode disables the button and says so in its tooltip.

The Token Speedometer's scale numbers sit directly on the bar, with no box behind them. A soft halo in the track colour keeps them readable over the tick marks, and a number the green fill has passed turns dark.

## Token Speedometer in Token Monitor

### Token Monitor fork (`vendor/token-monitor`)

`vendor/token-monitor` is a git submodule of [Screddyice/token-monitor](https://github.com/Screddyice/token-monitor), Screddy's fork of [Javis603/token-monitor](https://github.com/Javis603/token-monitor). It carries fixes Screddy needs before upstream has them. The first one makes Token Monitor read a Claude Code login stored for a custom `CLAUDE_CONFIG_DIR` on macOS: Claude Code keeps that login in the Keychain under `Claude Code-credentials-<first 8 hex digits of sha256(config dir)>`, and without it Token Monitor shows Claude's limits with no plan badge (for example no "Ultra"). The second puts Screddy's SR logo in Token Monitor's collapsed title in place of Σ; clicking it opens shawn-reddy.com. The fork's README lists its changes.

Fetch it with `git submodule update --init vendor/token-monitor`; a plain clone leaves the folder empty, and CI does not need it. The fork has its own tooling (`npm ci`, `npm test`, `npm run verify`), so Screddy's `vp fmt`, `vp lint` and knip skip `vendor/`. To move to a newer fork commit, check it out inside `vendor/token-monitor` and commit the submodule change here. `scripts/vendor-submodule.test.ts` guards the submodule entry and the `vendor/**` ignores; it loads the root `vite.config.ts` at run time, so `pnpm typecheck` for `scripts` stays within that project's own files.

The desktop app ships the Token Speedometer plug-in for Token Monitor, a separate open-source app. Each time Screddy starts, it copies the plug-in into Token Monitor's plug-in folder if Token Monitor is installed and the copy there is missing, older or changed. Token Monitor only runs a plug-in you have approved, so after a new copy lands, open Token Monitor › Plugins and approve the speedometer. Screddy leaves the copy alone if Token Monitor installed it from a package, if that copy is a newer version, or while Token Monitor is changing plug-ins. It does not install Token Monitor itself. The plug-in also restyles Token Monitor's Home limits as bordered cards; since 1.6.7 each card keeps an even 9px inset with 8px between cards, matching the selectors Token Monitor's own row layout uses so its zero padding no longer wins.

If you installed the speedometer from a `.tmplugin` file, update it the same way: Token Monitor › Plugins › Install from file. Token Monitor refuses an update that keeps the same version, so any change to the files in `integrations/token-monitor-speedometer` needs a new version in its `manifest.json`. `DesktopTokenMonitorPlugin.test.ts` fails until you bump it and record the new hash.

When Token Monitor is installed, the menu under the SR logo in the macOS menu bar has a Token Monitor section: today's tokens and cost, how much of each plan limit is left (for example "Claude Weekly · 63% left"), and Open Token Monitor…. While the speedometer runs in Token Monitor, it writes these numbers to `~/.screddys-ide/userdata/token-monitor/snapshot.json` every 30 seconds, and Screddy reads that file. The plug-in runs in the background so the numbers stay current; Token Monitor asks you to allow that when it installs or updates the plug-in. Numbers more than 10 minutes old are not shown, and the menu says so instead.

Screddy's SR logo always stays in the menu bar. With Token Monitor installed, clicking it opens Token Monitor's panel with the speedometer and limits, clicking it again closes the panel, and right-clicking it opens Screddy's token menu; without Token Monitor, either click opens the menu. Screddy no longer hides its logo when Token Monitor reports its own icon: on 2026-11-24 Token Monitor's icon was hidden (by a full menu bar or macOS's menu-bar settings, which no other app can check), so hiding Screddy's left no SR logo at all. Token Monitor treats only clicks on its own icon as a toggle and hides its panel when it loses focus, so while the panel is open Screddy watches it (one `osascript` process, `tokenMonitorPanel.ts`); a second click hands focus back to the app that was in front, which closes it. The panel counts as open from the first click, so a second click while it is still appearing closes it too; a second click that comes before Screddy has even asked Token Monitor to open cancels that open, so the panel never appears and focus stays put. A close counts at once, so the next click opens it again even if the watcher never reports the close. If the watcher cannot start or stays silent, Screddy still opens Token Monitor within a second. Token Monitor draws plug-in menu-bar icons in one color to match the menu bar, so its logo is not green.

## Upstream T3 Code documentation

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installing upstream T3 Code

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest`. It offers to install the `t3` command for you.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
