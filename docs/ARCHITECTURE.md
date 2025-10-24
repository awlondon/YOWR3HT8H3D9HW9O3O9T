# Architecture Overview

The HLSF Cognition Engine combines a browser-based user interface, long-running language model workflows, and a static adjacency database. This document highlights the major modules and data flows introduced by the modular front-end build.

## Front-end

The front-end is bundled with [Vite](https://vitejs.dev/) and written in TypeScript. Entry points are located in the `src/` directory:

- `src/main.ts` loads global styles and bootstraps the application by importing the runtime modules.
- `src/app.ts` contains the interactive shell implementation, state management, and graph rendering logic migrated from the original inline script.
- `src/styles.css` encapsulates the theme, layout, and component styling that was previously inline in `index.html`.

Future work can split `src/app.ts` into dedicated feature modules (graph rendering, command handling, persistence) without modifying the HTML shell.

## Remote database

Static adjacency data is generated from the exported database JSON using the scripts in the `scripts/` directory. Generated artifacts are written to `remote-db/` and consumed by the browser at runtime. The build pipeline now records chunk metadata, token indices, and supports future versioning improvements.

## Tooling

- **TypeScript** provides gradual typing for browser logic and integrates with modern editors.
- **ESLint** (`npm run lint`) enforces consistent code quality rules across TypeScript modules.
- **Prettier** (`npm run format`) standardises formatting for TypeScript, JSON, CSS, and Markdown files.
- **Vite** offers a lightning-fast development server and production build targeting evergreen browsers.

## Data flow summary

1. Users interact with the UI rendered from `index.html`.
2. `src/main.ts` loads, applies styles, and executes `src/app.ts` which initialises state, binds DOM events, and sets up graph visualisation.
3. The application fetches adjacency chunks from `remote-db/` as required, caches results locally, and drives the interface updates.
4. For LLM-backed flows the user supplies an API key, after which requests are issued directly from the browser (a proxy service can be added for secure delegation).

This modular structure lays the groundwork for introducing web workers, alternative UI frameworks, and expanded automated testing.
