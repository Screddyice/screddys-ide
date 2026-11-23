# Screddy

A macOS coding-agent workspace based on [T3 Code v0.1.9](https://github.com/pingdotgg/t3code/releases/tag/v0.1.9). Use your existing Codex, Claude Code, or other supported agents to work across projects, terminals, Git worktrees, and diffs. The upstream [MIT license](./LICENSE) applies.

## Build and run on Apple Silicon

Use Node 26.12.1, pnpm 12.14.0, Xcode Command Line Tools, and Rust with the `aarch64-apple-darwin` target. From the repository root:

```sh
pnpm install --frozen-lockfile
cp -n .env.example .env
pnpm exec node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version 0.1.9
```

The optional `.env` step includes the upstream public T3 Connect configuration. The local build uses its own app bundle and stores server data in `~/.screddys-ide/userdata` and its macOS browser profile in `~/Library/Application Support/screddys-ide-v2`. Development uses `~/.screddys-ide-dev` by default. To run from source, use `pnpm run dev:desktop --no-seed`.

## Build a preview from main

Run **Package Screddy for Apple Silicon** on the `main` branch in GitHub Actions with a version such as `0.1.37-preview.20261122.1`. It runs the Mission Control regression tests and attaches the DMG, ZIP, and SHA-256 checksums to the private workflow run. Preview builds do not carry an automatic update feed. Developer ID signing, notarization, and release publication require a separate distribution setup.

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

The endpoint is relative to the machine running the IDE environment. Setup is opt-in. Keep models reserved for standalone terminal use out of these provider and text-generator settings.

## Split workspace

Use **Split workspace** in a thread header to add a side-by-side pane. Each pane can show another existing thread. A diff opened from a split pane appears as a sheet on the right.

The Local Qwen pane has been removed. A layout saved while it existed still loads, with that pane blank.

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
