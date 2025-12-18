# Embedding Tags for Adjacency Families

Edge embeddings should capture both the fine-grained relation key and its higher-level family so downstream ranking can weight families differently.

- Append the `family` as a **LoRA tag** (e.g., `family:spatial`, `family:evidential`) when training adapters on edge text.
- When generating dense vectors, treat the family as a **separate feature channel** (one-hot vector) concatenated to the relation embedding before projection.
- Preserve the raw `type` string so cached vectors can be reclassified if the taxonomy changes.
- Unknown or new relation keys may remain `aesthetic`; add explicit mappings in `src/types/adjacencyFamilies.ts` and `hlsf_db_tools/adjacency_families.py` as they stabilize.

Embedders that cannot add new channels should still prefix prompts with the family tag so similarity search keeps the taxonomy visible to the model.
