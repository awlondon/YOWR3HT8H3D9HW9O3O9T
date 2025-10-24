# HLSF Cognition Engine

The HLSF Cognition Engine is a browser-based workbench for analyzing language prompts through recursive token adjacency mapping. It pairs a console-style UI with automated OpenAI-powered pipelines that derive conceptual graphs, extract thematic insights, and rewrite responses based on emergent relationships.

## Project Structure

- `index.html` – Static HTML shell that loads the bundled application from Vite.
- `src/` – TypeScript sources used to build the interface and runtime logic.
  - `main.ts` bootstraps the application and applies global styling.
  - `app.ts` contains the cognition engine runtime migrated from the original inline script.
  - `styles.css` defines the UI theme and layout.
- `remote-db/` – Chunked HLSF adjacency data and metadata used for on-demand hydration.
- `scripts/` – Python utilities for processing the exported database snapshots.
- `docs/` – Architecture notes and other reference material.

## Quick Start

1. Install dependencies and start the Vite dev server:
   ```bash
   npm install
   npm run dev
   ```
   Open `http://localhost:5173` to interact with the engine in development mode.

2. For a production build that can be hosted statically:
   ```bash
   npm run build
   ```
   The output is written to `dist/`. Serve the directory with any static file server.

3. Alternatively, open `index.html` directly in a modern browser to run the pre-built bundle without the dev server.

When prompted, enter an OpenAI API key (`sk-...`) to enable live calls. Selecting **Continue offline** dismisses the modal and restricts the app to cached or offline behaviors. Keys are stored only in memory.

## Development Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server with hot module replacement. |
| `npm run build` | Produce an optimized production bundle. |
| `npm run preview` | Preview the production build locally. |
| `npm run lint` | Run ESLint across the TypeScript sources. |
| `npm run format` | Format TypeScript, CSS, JSON, and Markdown files with Prettier. |

## Remote Database Workflow

Run `python scripts/process_latest_db.py` to generate the chunked adjacency dataset from the latest export. Artifacts are written to `remote-db/` and include `metadata.json`, per-prefix chunks, and a sorted token index.

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [Contributing guidelines](CONTRIBUTING.md)

## License

This project is licensed under the [MIT License](LICENSE).
