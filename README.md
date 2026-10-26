<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://learnharness.ai">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Add your provider API key and choose your models, then start a session with what you want to understand. LearnHarness supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Optional dictation and web search use separate service keys.

All three platforms support in-app updates.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## This fork

This fork ([gabrielurs/learnharness](https://github.com/gabrielurs/learnharness)) tracks upstream and adds:

- **Claude subscription instead of an API key.** The `claude-code` provider drives the [Claude Code](https://claude.com/claude-code) CLI headless, so model calls use your Claude plan's quota and cost nothing per token. Pick `claude-code` models in the model slots.
- **C/C++ exercises.** Learner code compiles and runs in a locked-down Docker container (no network, no host files, memory and process limits). The editor's clangd completions and diagnostics run in Docker too.
- **Study aids.** Uninterrupted browser dictation in Safari, spoken confidence, retry for failed turns, and a Pomodoro-style study timer.
- **Hardening.** The server listens on loopback only and rejects cross-origin requests; `web_fetch` blocks private addresses, DNS rebinding and redirect tricks.

Requirements on top of upstream: Node 26, the `claude` CLI installed and logged in, and Docker running for code exercises (without Docker, code runs under a macOS sandbox fallback and the editor gets no clangd assistance).

## Development and support

```bash
make install       # npm ci
make sandbox       # check Docker, pull the pinned C/C++ image
make dev           # http://127.0.0.1:3000
make check         # typecheck, test, lint (what CI runs)
make               # list every target
```

The `npm run` scripts still work; the Makefile only wraps them.

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
