# HLSF Cognition Engine

The HLSF Cognition Engine is a self-contained web workbench for analyzing language prompts through recursive token adjacency mapping. It pairs a console-style UI with automated OpenAI-powered pipelines that derive conceptual graphs, extract thematic insights, and rewrite responses based on emergent relationships. 【F:index.html†L1-L116】【F:index.html†L965-L1118】

## Project Structure

This repository contains a single-page application:

- `index.html` – The complete interface, styling, and JavaScript logic for the cognition engine, including the modal for API configuration, logging console, command handler, and processing routines. 【F:index.html†L435-L608】【F:index.html†L965-L1190】

## Quick Start

1. Open `index.html` in any modern desktop browser. The layout adapts to smaller screens, but the experience is optimized for wider viewports. 【F:index.html†L35-L411】
2. When prompted, enter an OpenAI API key (`sk-...`) to enable live calls. Selecting **Continue offline** dismisses the modal and restricts the app to cached or offline behaviors. Keys are stored only in memory. 【F:index.html†L435-L567】
3. Type a natural-language prompt or a `/command` into the input bar and press **Send** (or hit Enter). 【F:index.html†L448-L608】【F:index.html†L1193-L1209】
4. Watch the command log update as the engine gathers LLM output, fetches adjacency matrices, and renders analysis artifacts. Offline mode returns placeholder responses where live synthesis is unavailable. 【F:index.html†L984-L1150】

> **Note:** The application communicates directly with the OpenAI Chat Completions API from the browser. Ensure you trust the execution environment before supplying credentials. 【F:index.html†L610-L707】

## Core Workflow

For each submitted prompt, the engine performs the following stages:

1. **Token validation** – Splits the prompt, enforces a 100-token ceiling, and annotates input/output token counts in the log. 【F:index.html†L532-L542】【F:index.html†L971-L1001】
2. **Primary response generation** – Sends the prompt to OpenAI (when authorized) or emits an offline placeholder if no key is present. 【F:index.html†L986-L997】
3. **Adjacency acquisition** – Requests token adjacency matrices for both prompt and response tokens, with concurrency control, caching, and offline fallbacks. 【F:index.html†L671-L761】【F:index.html†L1002-L1016】
4. **Attention analytics** – Calculates attention scores, densities, hubs, and bridge tokens, then summarizes high-salience nodes in the log. 【F:index.html†L764-L832】【F:index.html†L1017-L1028】
5. **Insight synthesis** – Optionally asks the LLM to narrate conceptual insights and emergent thought streams derived from adjacency data. 【F:index.html†L1029-L1070】
6. **Response revision** – Generates a refined answer aligned with analyzed relationships and presents a collapsible report containing the original output, thought stream, and token matrices. 【F:index.html†L1071-L1117】
7. **Persistence & export** – Stores session summaries (up to 50) in `localStorage`, bundles cached adjacency data, and triggers a JSON download for archival. 【F:index.html†L907-L959】【F:index.html†L1151-L1177】

## Commands

Use leading slashes to control the environment without leaving the keyboard. Commands are case-insensitive.

| Command | Description |
| --- | --- |
| `/help` | Show the available commands. 【F:index.html†L548-L606】|
| `/clear` | Clear the command log. 【F:index.html†L573-L579】|
| `/export` | Download a JSON bundle of the current session matrices and cached data. 【F:index.html†L573-L582】【F:index.html†L907-L944】|
| `/reset` | Purge cached adjacency matrices from `localStorage`. 【F:index.html†L583-L586】|
| `/depth [1-5]` | Adjust recursion depth used for multi-pass processing. 【F:index.html†L587-L600】|

## Data Artifacts

Each processed prompt produces a structured JSON export that contains:

- Session metadata (timestamps, original and revised responses, emergent thoughts). 【F:index.html†L926-L944】
- Serialized adjacency matrices used during analysis. 【F:index.html†L907-L944】【F:index.html†L1134-L1149】
- Derived metrics such as recursion depth, token counts, and stored matrix totals. 【F:index.html†L907-L1174】

Exports are automatically triggered after every run and saved as `HLSF_Session_<timestamp>.json` in the browser’s download directory. 【F:index.html†L907-L919】【F:index.html†L1151-L1177】

## Offline Behavior

- Without an API key, the app skips live LLM calls and marks the log with offline warnings while still permitting manual exploration of cached matrices. 【F:index.html†L995-L997】【F:index.html†L1049-L1070】
- Adjacency fetches fall back to cached results or an offline stub per token when the network layer is disabled. 【F:index.html†L715-L751】

## Development Notes

- All logic lives in vanilla HTML/CSS/JS, making it easy to host on static servers or run locally without a build step. 【F:index.html†L1-L432】【F:index.html†L467-L1216】
- Browser storage (via `localStorage`) is used for memoizing adjacency matrices and session histories; clearing site data resets the tool. 【F:index.html†L653-L959】
- Responsive design rules ensure usability on narrow screens by stacking the input area and adjusting header layout. 【F:index.html†L393-L411】

## License

This project currently ships without an explicit license. Add one before distributing publicly.
