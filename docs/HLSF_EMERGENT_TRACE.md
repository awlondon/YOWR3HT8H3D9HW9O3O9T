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

- `src/engine/cognitionCycle.ts` now injects these directives into the system prompt it sends to `/api/llm`, ensuring every completion follows the emergent trace rubric.
- The console UI still streams rotation thoughts, but the downstream LLM response is now required to surface labeled sections such as “Emergent Thought Trace” and “Structured Response.”
- Additional tools can reuse this document as a checklist when auditing cognition runs or designing new prompt templates.
