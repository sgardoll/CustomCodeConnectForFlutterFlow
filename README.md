# FlutterFlow Custom Code Connect

There are many AI code generators. This one actually works in FlutterFlow.

[GitHub](https://github.com/sgardoll/CustomCodeConnectForFlutterFlow) · [Demo Video](https://www.youtube.com/watch?v=zRjexvW58IQ) · [Report Bug](https://github.com/sgardoll/CustomCodeConnectForFlutterFlow/issues)

Requires **Node 20.19+ or 22.12+** (Vite 7's floor). `.nvmrc` holds the version this project is built and tested with — run `nvm use` first if you use nvm. `package.json` declares the same range under `engines`, so an unsupported Node warns at install time instead of failing mid-build.

```bash
git clone https://github.com/sgardoll/CustomCodeConnectForFlutterFlow.git
cd CustomCodeConnectForFlutterFlow
npm install && npm run dev
```

## The Wall

FlutterFlow is incredible for building apps fast—until you need something custom. A radial gauge. A signature pad. An audio visualizer. Suddenly you're staring at a blank Custom Widget editor with a generic AI that has no idea what FlutterFlow will and won't accept.

`void main()`. `Scaffold`. `import 'package:flutter/material.dart'`. Forbidden. All of it.

## What This Does

FlutterFlow Custom Code Connect is a three-step pipeline that generates **FlutterFlow-ready artifacts**, not just Flutter code.

Step 1 — **Prompt Architect** — analyzes your request and produces a spec: artifact type, parameters, required Data Types, applicable constraints.

Step 2 — **Code Generator** — takes the spec and FlutterFlow's rules and outputs Dart code that actually compiles. No forbidden patterns, no forbidden imports, proper null safety, correct callback signatures.

Step 3 — **Code Review** — audits the output. Scores 0–100. Lists every critical issue with an exact fix. Surfaces the FlutterFlow UI actions you still need to take manually (add a dependency, create a Data Type).

Then you either copy to clipboard or commit directly to FlutterFlow via the API.

## Artifact Types

The pipeline knows the difference between a Custom Function, Custom Action, Custom Widget, and Code File—and applies the right constraints for each automatically.

**Custom Function** — sync logic, math, formatting. No external packages. Pure Dart only.

**Custom Action** — async operations, APIs, side effects. Must return `Future<T>`. Packages allowed.

**Custom Widget** — visual components. Must handle `width`/`height`, use `LayoutBuilder`, no `Scaffold`.

**Code File** — reusable models, enums, utilities. No generics. No function-typed fields.

## Direct Deployment

Connect your FlutterFlow API key and skip the copy-paste workflow entirely. The tool validates the code, extracts dependencies for `pubspec.yaml`, packages everything into a zip, and pushes to your project. Production and staging endpoints supported.

## Deploying This Project

Four surfaces — three automated, one manual. Full detail in [DEPLOYMENT.md](DEPLOYMENT.md).

- **Web app** — `python3 scripts/deploy_ftp.py` mirrors `dist/` to the FTP root.
- **FlutterFlow custom-class runner** — `./scripts/deploy_cloud_run_ffai.sh` builds and ships `cloud-run/ffai-runner` to Cloud Run.
- **BuildShip workflow** `service-runpipeline-THIN` — pushed over the BuildShip MCP, against the workflow graph in the BuildShip repo.
- **BuildShip step system prompts** (Architect, Generator, Review) — **manual**. They are node inputs, not workflow code, so a workflow push does not carry them; they are pasted into the BuildShip editor, and that paste is the deploy. Their source of truth is the private BuildShip workflow, not this public repository; the local copies are gitignored on purpose.

## Multi-Model

Gemini (primary), Claude, GPT, OpenRouter. Switch anytime. Each gets prompts tuned to its strengths. Gemini Flash as automatic fallback if the primary fails.

When FlutterFlow returns build errors, paste them back in. **Regenerate with Errors** feeds them to the AI with your original intent and outputs corrected code.

## Setup

Node **20.19+ or 22.12+** is required — Vite 7's floor. `.nvmrc` pins the version this project is built with, and `engines` in `package.json` declares the range, so an unsupported Node warns at install instead of failing at the first `vite` invocation (`npm run build`, `npm run test:key-storage`).

Create `.env` in the project root:

```env
VITE_GEMINI_API_KEY=your_key_here
VITE_ANTHROPIC_API_KEY=optional
VITE_OPENAI_API_KEY=optional
VITE_OPENROUTER_API_KEY=optional
```

Get keys: [Google AI Studio](https://aistudio.google.com/apikey) · [FlutterFlow API](https://app.flutterflow.io/settings/api)

```bash
npm run dev      # development
npm run build    # production build
npm run preview  # preview build
```

## Stack

Vanilla JS + Tailwind CSS · Vite 7 · Web Crypto API (AES-GCM) · JSZip · Highlight.js

## Philosophy

This tool solves one problem: generic AI breaks in FlutterFlow. The constraints aren't configurable because they aren't opinions—they're FlutterFlow's rules. The pipeline enforces them so you don't have to memorize them.

---

MIT License · [sgardoll](https://github.com/sgardoll)
