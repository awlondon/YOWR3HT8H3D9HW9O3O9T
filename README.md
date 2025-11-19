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
- [Backend hardening guide](#backend-hardening-guide)
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
- Recursive adjacency building applies configurable depth/degree caps and weight aggregation (`src/features/graph/recursive_adjacency.ts`).
- Metrics summarise token density, edge histograms, and salience rankings for downstream tooling (`src/analytics/metrics.ts`).

### Emergent thought trace workflow

- The cognition engine mandates a multi-step HLSF reasoning routine that covers decomposition, conceptual clustering, HLSF mapping, interconnection reflection, refinement, and structured response delivery (`docs/HLSF_EMERGENT_TRACE.md`).
- `callLLM` (`src/engine/cognitionCycle.ts`) injects this directive into every `/api/llm` request so completions return clearly labeled **Emergent Thought Trace** and **Structured Response** sections aligned with the High-Level Semantic Field.

### Consciousness analytics

- Workspace propagation models salience broadcast over multiple iterations (`src/engine/consciousness.ts`).
- Causal impact estimates highlight tokens that meaningfully change integration scores when removed.
- Results can be surfaced inside the `/state` and `/self` console commands for debugging sessions (`src/app.ts`).

### Knowledge base storage

- `src/kb/` hosts the pluggable knowledge base used by the engine and UI caches. The facade (`src/kb/index.ts`)
  exposes a typed `KBStore` API while adapters implement concrete storage backends.
- The default IndexedDB adapter (`src/kb/adapters/idb.ts`) persists columnar edge blocks with gzip
  compression, prefix sharding, and background-safe transactions. A memory adapter is provided for tests
  and headless environments, while a SQLite-WASM adapter stub documents the optional WASM driver.
- Edge blocks (`src/kb/schema.ts`, `src/kb/encode.ts`) store adjacency columns in typed arrays, enabling
  fast lookups and future compression/GC policies (`src/kb/gc.ts`, `src/kb/shard.ts`).
- A dedicated worker (`src/workers/kb.worker.ts`) fans heavy GC, compaction, and bulk imports off the main
  thread. `src/state/kbStore.ts` provides a singleton initialiser that picks the best adapter at runtime.

### Remote database and persistence

- Sharded adjacency data lives under `remote-db/<A–Z>/<AA–ZZ>.json` and can be refreshed with `hlsf_partition.py`.
- The browser File System Access API writer coordinates background chunk syncs and emits progress signals
  (`src/engine/remoteDbWriter.ts`).
- The importer is idempotent and merges token relationships by weight and timestamp (`hlsf_partition.py`).

### SaaS workspace

- `/signup`, `/switchuser`, `/plan`, and credit purchase commands manage profiles, billing, and ledgers (`src/features/saas/platform.ts`).
- Encrypted messaging and ledgers rely on symmetric key helpers with base64 previews (`src/lib/crypto/encryption.ts`).
- Subscription and credit models track purchases in standardised tiers routed to the primary billing account (`src/features/saas/subscription.ts`).

### Voice cloning and audio modelling

- The voice clone panel indexes prompt tokens, expression tags, and synthesis statistics directly in the browser
  (`src/features/voice/voiceClone.ts`).
- Voice model presets expose quick-start parameters for different OpenAI voice APIs (`src/features/voice/voiceModel.ts`).
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
- `src/features/graph/` provides recursive adjacency builders and symbol edge emitters used by the pipeline.
- `src/analytics/` records metrics, command usage, and telemetry for runtime observability.
- `src/features/voice/`, `src/userAvatar/`, and `src/onboarding/` enrich the UI with auxiliary features.

### Data flow

1. Prompts tokenized via symbol-aware tokenizer with optional neighbour maps (`src/tokens/tokenize.ts`).
2. Graph edges emitted from adjacency recursion and symbol heuristics (`src/features/graph/recursive_adjacency.ts`, `src/features/graph/symbolEdges.ts`).
3. Consciousness propagation iterates salience broadcasts and causal estimates (`src/engine/consciousness.ts`).
4. Remote DB writers and exports persist updated shards and session metadata (`src/engine/remoteDbWriter.ts`, `src/export/session.ts`).

## Directory reference

- `src/app.ts` – Console shell, command catalog, SaaS logic, prompt workflows.
- `src/engine/` – Prompt pipeline, consciousness analytics, remote DB sync utilities.
- `src/features/graph/` – Recursive adjacency builders and symbol edge emitters.
- `src/analytics/` – Telemetry, metrics, and command usage instrumentation.
- `src/features/voice/` – Voice cloning dashboard and model presets.
- `src/features/saas/` – SaaS platform composition, subscriptions, encryption, messaging.
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

When prompted, enter an OpenAI API key (`sk-...`) to enable live completions. Check **Remember this key** to store it locally after encrypting with the browser's AES-GCM implementation. Reuse is always explicit via the **Use saved key** button, and **Forget saved key** wipes the encrypted payload immediately. Select **Continue offline** to limit the engine to cached workflows.

### LLM endpoint configuration

Set `VITE_LLM_ENDPOINT` to point the front-end at your LLM proxy (defaults to `/api/llm`). The value can be an absolute URL or a relative path resolved against the current origin. When loading the bundle directly from `file://`, provide an absolute endpoint (for example `https://your-llm-host.example.com/api/llm`) so the cognition cycle can reach a backend instead of returning a 404.

### LLM stub toggle

The browser fetch stub that intercepts `/api/llm` requests is now opt-in. Set `VITE_ENABLE_LLM_STUB=off` (or `on`) in your Vite environment to force a particular mode. The default `auto` value only installs the stub during `npm run dev`, allowing production builds to reach a real backend.

If the LLM endpoint is unreachable, the cognition status will surface the HTTP error (for example `LLM backend failed (HTTP 404)`) and the articulated response panel will display a clear message plus a fallback composed from the HLSF Output Suite when available.

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

### Type checking

```bash
npm run typecheck
```

Runs strict TypeScript checks across storage, security, vector, worker, and server stub modules.

### Tests

```bash
npm test
```

Compiles the test bundle (`tsconfig.test.json`) and executes Node-based unit tests for analytics, graph logic, and SaaS helpers.

### Full gate / CI parity

```bash
npm run check
```

Runs linting, formatting checks, type-checking, and the Node test runner in one command. GitHub Actions invokes this
script via [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on every push and pull request so server hardening
and front-end changes are validated consistently.

## Data workflows

### Partition adjacency exports

Detailed command examples for the Python utilities live in
[`docs/DATA_PROCESSING.md`](docs/DATA_PROCESSING.md).

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

## Backend hardening guide

The legacy proof-of-concept API that originally lived in `app.ts` is being replaced with a layered Node/Express service.
The [Backend Hardening Playbook](docs/BACKEND_HARDENING.md) captures the roadmap and prescriptive checklists for:

- Structuring the project into config, middleware, controllers, services, and data access layers.
- Validating environment variables and Mongo connections with retries and graceful shutdown hooks.
- Installing shared security middleware (restricted CORS, Helmet, rate limiting, sanitisation) and typed
  validation.
- Instrumenting logging/metrics plus CI hooks so server changes inherit the same rigor as the Vite client.

Use the playbook before extending SaaS commands that require server orchestration or before deploying the hosted offering.

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
