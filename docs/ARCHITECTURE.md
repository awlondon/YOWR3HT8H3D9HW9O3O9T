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

### Layered semantic adjacency

The cognition engine expands each token’s relationships in discrete semantic layers. Level 0 records the circular backbone between sequential tokens. Subsequent levels (up to `maxAdjacencyLayers`) introduce indirect connections that pass a cosine-similarity gate sourced from the vector store. The per-level degree caps defined by `maxAdjacencyDegreePerLayer` keep the graph sparse while still permitting high-similarity “long range” edges when no short path exists. These parameters, along with `adjacencySimilarityThreshold` and `adjacencyStrongSimilarityThreshold`, are surfaced through the runtime settings so operators can trade off recall against density for different performance profiles.

## Tooling

- **TypeScript** provides gradual typing for browser logic and integrates with modern editors.
- **ESLint** (`npm run lint`) enforces consistent code quality rules across TypeScript modules.
- **Prettier** (`npm run format`) standardises formatting for TypeScript, JSON, CSS, and Markdown files.
- **Vite** offers a lightning-fast development server and production build targeting evergreen browsers.

## SaaS platform layer

The `src/features/saas/` directory introduces a modular software-as-a-service layer that wraps the existing
interactive shell:

- `platform.ts` composes the SaaS platform, wiring subscription management, user profiles, and
  messaging features together while exposing helpers for command registration.
- `subscription.ts` tracks subscription lifecycle events, recurring billing, LLM API credit
  balances, and top-up purchases in $10, $20, $50, $100, or $1,000 blocks.
- `userDirectory.ts` and `encryption.ts` let users instantiate private profiles with unique
  encryption keys for their ledgers and messaging history.
- `messaging.ts` stores only encrypted message payloads while exposing decryption exclusively to the
  owning profile.

Command handlers are registered through `registerSaasCommands`, allowing the console UI to offer
`/signup`, `/userlist`, `/plan`, `/topup`, `/message`, `/inbox`, and `/decryptmsg` workflows. Payment
instructions are standardised so that subscription and credit purchases are routed to
`@primarydesignco` via the PayPal-based credit-card exchange service.

## Data flow summary

1. Users interact with the UI rendered from `index.html`.
2. `src/main.ts` loads, applies styles, and executes `src/app.ts` which initialises state, binds DOM events, and sets up graph visualisation.
3. The application fetches adjacency chunks from `remote-db/` as required, caches results locally, and drives the interface updates.
4. For LLM-backed flows the user supplies an API key, after which requests are issued directly from the browser (a proxy service can be added for secure delegation).

This modular structure lays the groundwork for introducing web workers, alternative UI frameworks, and expanded automated testing.
