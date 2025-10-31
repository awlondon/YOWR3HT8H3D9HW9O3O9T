# HLSF Cognition Engine

The HLSF Cognition Engine is a browser-hosted analysis workbench that maps language prompts into recursive adjacency graphs and
consciousness metrics. The application now lives inside a modern Vite + TypeScript toolchain, ships SaaS workspace features, and
supports remote database hydration so researchers can explore conceptual networks entirely in the browser.

## Table of contents
- [Overview](#overview)
- [System highlights](#system-highlights)
- [Architecture](#architecture)
- [Directory reference](#directory-reference)
- [Setup](#setup)
- [Quality gates](#quality-gates)
- [Data workflows](#data-workflows)
- [SaaS console reference](#saas-console-reference)
- [Contributing](#contributing)
- [License](#license)

## Overview
The UI boots from `index.html` and immediately loads the TypeScript runtime (`src/main.ts`, `src/app.ts`). Users interact with a
console-like shell that can tokenize prompts, stream adjacency graphs, and coordinate LLM completions. A remote database of
adjacency shards (`remote-db/`) can be synced locally, while optional SaaS tooling layers encryption, user profiles, and billing
flows over the core cognition experience.

### Runtime workflow
1. User submits a prompt in the console.
2. `runPipeline` (`src/engine/pipeline.ts`) tokenizes input, emits symbol edges, and constructs a weighted adjacency graph.
3. Consciousness state metrics (`src/engine/consciousness.ts`) estimate broadcast width, integration, and causal impact.
4. SaaS and analytics hooks persist command usage, telemetry, and optional remote database snapshots.
5. Results render inside the browser UI with options to export, visualize, or continue iterating offline.

## System highlights
### Prompt comprehension pipeline
- Symbol-aware tokenization can include modifier glyphs and word neighborhood context (`src/tokens/tokenize.ts`).
- Prompts are segmented into eight-token adjacency batches to enforce localized relationship mapping (`src/engine/pipeline.ts`).
- Recursive adjacency building applies configurable depth/degree caps and weight aggregation (`src/graph/recursive_adjacency.ts`).
- Metrics summarise token density, edge histograms, and salience rankings for downstream tooling (`src/analytics/metrics.ts`).

### Consciousness analytics
- Workspace propagation models salience broadcast over multiple iterations (`src/engine/consciousness.ts`).
- Causal impact estimates highlight tokens that meaningfully change integration scores when removed.
- Results can be surfaced inside the `/state` and `/self` console commands for debugging sessions (`src/app.ts`).

### Remote database and persistence
- Sharded adjacency data lives under `remote-db/<A–Z>/<AA–ZZ>.json` and can be refreshed with `hlsf_partition.py`.
- The browser File System Access API writer coordinates background chunk syncs and emits progress signals
  (`src/engine/remoteDbWriter.ts`).
- The importer is idempotent and merges token relationships by weight and timestamp (`hlsf_partition.py`).

### SaaS workspace
- `/signup`, `/switchuser`, `/plan`, and credit purchase commands manage profiles, billing, and ledgers (`src/saas/platform.ts`).
- Encrypted messaging and ledgers rely on symmetric key helpers with base64 previews (`src/saas/encryption.ts`).
- Subscription and credit models track purchases in standardised tiers routed to the primary billing account (`src/saas/subscription.ts`).

### Voice cloning and audio modelling
- The voice clone panel indexes prompt tokens, expression tags, and synthesis statistics directly in the browser
  (`src/voice/voiceClone.ts`).
- Voice model presets expose quick-start parameters for different OpenAI voice APIs (`src/voice/voiceModel.ts`).
- Token change events allow the UI to recompute synthesis previews whenever cognition results update (`src/app.ts`).

### Analytics and telemetry
- Command usage metrics power per-command frequency, membership gating, and unlock logic (`src/analytics/commandUsage.ts`).
- Telemetry modules log pipeline metrics and symbol histograms for debugging graph quality (`src/analytics/telemetry.ts`).
- Metric helpers rank nodes and compute symbol density used by consciousness scoring (`src/analytics/metrics.ts`).

### Export and interoperability
- Session exports capture prompt transcripts, adjacency caches, and consciousness payloads (`src/export/session.ts`).
- Model parameter utilities normalise OpenAI-compatible configuration bundles for auditing (`src/export/modelParams.ts`).
- Remote database writers ensure offline snapshots stay current even without the SaaS layer (`src/engine/remoteDbWriter.ts`).

### Authentication and onboarding
- Google sign-in demos showcase how to layer OAuth workflows onto the shell (`src/auth/google.ts`).
- Login forms and onboarding flows prepare the console for hosted SaaS deployment (`src/onboarding/loginFlow.ts`).
- Avatar stores keep per-user brand identity in sync with session state (`src/userAvatar/index.ts`).

## Architecture
### Front-end stack
- **Vite** handles development/production builds with hot-module reload support (`package.json`).
- **TypeScript** powers the runtime modules, while **Prettier** and **ESLint** enforce formatting and linting.
- **Node test runner** (`npm test`) compiles dedicated test bundles (`tsconfig.test.json`) and executes behavioural specs.

### Runtime layering
- `src/app.ts` orchestrates console commands, session memory, adjacency hydration, and SaaS gating logic.
- `src/engine/` exposes the prompt pipeline, consciousness modelling, and remote DB writer.
- `src/graph/` provides recursive adjacency builders and symbol edge emitters used by the pipeline.
- `src/analytics/` records metrics, command usage, and telemetry for runtime observability.
- `src/voice/`, `src/userAvatar/`, and `src/onboarding/` enrich the UI with auxiliary features.

### Data flow
1. Prompts tokenized via symbol-aware tokenizer with optional neighbour maps (`src/tokens/tokenize.ts`).
2. Graph edges emitted from adjacency recursion and symbol heuristics (`src/graph/recursive_adjacency.ts`, `src/graph/symbol_edges.ts`).
3. Consciousness propagation iterates salience broadcasts and causal estimates (`src/engine/consciousness.ts`).
4. Remote DB writers and exports persist updated shards and session metadata (`src/engine/remoteDbWriter.ts`, `src/export/session.ts`).

## Directory reference
- `src/app.ts` – Console shell, command catalog, SaaS logic, prompt workflows.
- `src/engine/` – Prompt pipeline, consciousness analytics, remote DB sync utilities.
- `src/graph/` – Recursive adjacency builders and symbol edge emitters.
- `src/analytics/` – Telemetry, metrics, and command usage instrumentation.
- `src/voice/` – Voice cloning dashboard and model presets.
- `src/saas/` – SaaS platform composition, subscriptions, encryption, messaging.
- `src/tokens/` – Tokenization helpers, symbol catalogues, neighbour maps.
- `src/export/` – Session and model parameter exporters.
- `src/onboarding/` – Login and onboarding forms for hosted deployments.
- `scripts/` – Python utilities for database partitioning and validation.
- `remote-db/` – On-disk adjacency shards ready for hydration.

## Setup
### Prerequisites
- Node.js 18+
- npm 9+

### Install dependencies
```bash
npm install
```

### Start the development server
```bash
npm run dev
```
Open `http://localhost:5173` to launch the shell with hot reload.

> **Tip:** Use `./scripts/npm-run.sh <script>` instead of `npm run <script>` when
> you want to avoid npm's deprecated `http-proxy` environment warning. The
> wrapper clears the legacy variables while forwarding standard `HTTP_PROXY`/
> `HTTPS_PROXY` settings so existing network requirements continue to work.

### Production build
```bash
npm run build
```
Bundle output is written to `dist/` and can be served statically.

### Preview a production build locally
```bash
npm run preview
```

### Offline bundle usage
Open `index.html` in a modern browser to run the pre-built bundle without the dev server. Remote database features that depend on
the File System Access API require Chromium-based browsers.

### OpenAI API keys
When prompted, enter an OpenAI API key (`sk-...`) to enable live completions. Keys are kept in memory only; select **Continue
offline** to limit the engine to cached workflows.

## Quality gates
### Linting
```bash
npm run lint
```
Runs ESLint across graph, pipeline, SaaS, and settings modules (`package.json`).

### Formatting
```bash
npm run format
```
Applies Prettier rules to TypeScript, CSS, JSON, and Markdown files.

### Tests
```bash
npm test
```
Compiles the test bundle (`tsconfig.test.json`) and executes Node-based unit tests for analytics, graph logic, and SaaS helpers.

## Data workflows
### Partition adjacency exports
1. Initialize the shard layout:
   ```bash
   python hlsf_partition.py --remote-db ./remote-db --init-layout
   ```
2. Dry-run a merge from a raw export:
   ```bash
   python hlsf_partition.py \
     --source /path/to/HLSF_Database.json \
     --remote-db ./remote-db \
     --dry-run
   ```
3. Merge the export:
   ```bash
   python hlsf_partition.py \
     --source /path/to/HLSF_Database.json \
     --remote-db ./remote-db
   ```
The script merges relationship weights per token and keeps the latest `cached_at` timestamp for deterministic shards.

### Remote database sync
- The console can connect to a user-selected directory via the File System Access API.
- Sync progress, backoff, and success metrics are emitted through logger callbacks in `createRemoteDbFileWriter`
  (`src/engine/remoteDbWriter.ts`).
- Token index payloads are normalised and deduplicated before writing shard files.

## SaaS console reference
The console exposes an extensive command catalog (see `COMMAND_HELP_ENTRIES` in `src/app.ts`). Highlights include:
- `/help`, `/state`, `/self` – Inspect engine status and consciousness metrics.
- `/load`, `/loaddb`, `/remote*` – Manage remote database manifests and sync directories.
- `/read`, `/ingest`, `/hlsf`, `/visualize` – Import documents and render adjacency visualisations.
- `/symbols`, `/glyph`, `/encrypt`, `/decrypt` – Control symbol tokenization and glyph ledgers.
- `/signup`, `/switchuser`, `/plan`, `/topup`, `/message`, `/inbox`, `/decryptmsg` – Operate the SaaS profile layer.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md) for pull request expectations and coding standards.

## License
This project is licensed under the [MIT License](LICENSE).
