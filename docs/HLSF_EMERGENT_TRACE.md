# HLSF Emergent Thought Process

This workflow formalises how the cognition engine decomposes prompts and guides the LLM so responses stay grounded in the High-Level Semantic Field (HLSF).

## Process outline

1. **Prompt decomposition** – enumerate the primary nouns, verbs, and relationships in the request. Note any ambiguous elements that require explicit assumptions.
2. **Conceptual clustering** – group related tokens, label each cluster, and explain why the grouping matters.
3. **High-Level Semantic Field mapping** – describe every cluster as an HLSF node, then highlight the explicit links that connect them.
4. **Interconnection reflection** – discuss how changes to one cluster ripple into others and identify feedback paths worth exploring.
5. **Iterative refinement** – revisit the HLSF after the first pass, adding or removing clusters/links so the structure stays clear but complete.
6. **Emergent thought trace** – keep a concise written reflection for each step; this exposes the reasoning shape without leaking the full chain-of-thought.
7. **Structured response** – answer the user using the HLSF order, clarify assumptions, situate the ideas in context, and end with actionable next steps.

## Runtime integration

- `src/engine/emergentThoughtEngine.ts` sequences all seven steps with named helpers (`decomposePrompt`, `clusterConcepts`, `buildHLSF`, `reflectInterconnections`, `refineHLSF`, `traceThoughts`, `composeStructuredResponse`).
- Rotation previews and spectrum summaries live in `src/engine/graphRotation.ts` and `src/engine/spectralUtils.ts`, keeping visual metaphors decoupled from cognition.
- Thought evaluation and articulation are managed in `src/engine/thoughtDetector.ts` and `src/engine/articulationManager.ts`, returning plain data for the UI to render.
- The UI should read the `EmergentResult` from `runEmergentThoughtProcess` and render separate panels for “Emergent Thought Trace” and “Structured Response.”
- Additional tools can reuse this document as a checklist when auditing cognition runs or designing new prompt templates.

## Seed node expansion and geometric intuition

- `src/features/graph/seedExpansion.ts` grows a triangular K_n scaffold around a base concept token. For the default dimension (n = 8) it produces three triangles that share boundary nodes, yielding a compact K8-style lattice anchored on the seed.
- `src/engine/hlsfReasoner.ts` invokes the seed expansion immediately after the initial graph build and again after convergence throttling selects a new hub. Operational edges from this stage are tagged with the `seed-expansion` relation so the ordered emergent pass can handle them after causal/temporal cues.
- The emergent trace now includes explicit seed-expansion notes, and the LLM prompt carries a seed summary alongside the user request so downstream articulation is aware of the induced triangles and adjacency intents.
- The graph visualizer (see `src/app.ts`) can color edges by family and optionally renders translucent triangles for any edges carrying a `triangleId` in their metadata, making the K8 lattice visible in the canvas view.
