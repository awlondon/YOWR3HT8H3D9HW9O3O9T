/**
 * LLM client abstraction.
 * - expandAdjacency: internal “thinking” step for each ThoughtEvent.
 * - articulateResponse: external response when an ArticulationEvent fires.
 *
 * NOTE: Implementation details depend on how this repo currently calls LLMs.
 * For now, provide method signatures and comments for integration.
 */

import {
  type ThoughtEvent,
  type AdjacencyDelta,
  type ArticulationEvent,
} from './cognitionTypes.js';

export interface LLMClient {
  expandAdjacency(ev: ThoughtEvent, depth?: number, maxDepth?: number): Promise<AdjacencyDelta>;
  seedAdjacency(token: string): Promise<AdjacencyDelta>;
  expandAdjacencyToken(token: string): Promise<AdjacencyDelta>;
  articulateResponse(
    articulation: ArticulationEvent,
    userQuestion: string,
    salientContext?: { tokens: string[]; summary: string },
  ): Promise<string>;
}

export class StubLLMClient implements LLMClient {
  modelName = 'stub-llm';

  async expandAdjacency(_ev: ThoughtEvent, depth = 0, maxDepth = 1): Promise<AdjacencyDelta> {
    void _ev;
    // TODO: Wire into actual LLM call with prompt:
    //
    // SYSTEM:
    //  You are an adjacency generator for a cognitive graph...
    //
    // USER:
    //  {ThoughtEvent JSON, depth: ${depth}, maxDepth: ${maxDepth}}
    //
    // Return JSON conforming to AdjacencyDelta.
    return { nodes: [], edges: [], notes: `stubbed_depth_${depth}` };
  }

  async seedAdjacency(token: string): Promise<AdjacencyDelta> {
    const norm = token.trim() || 'seed';
    const baseId = norm.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'seed';
    return {
      nodes: [
        { id: `${baseId}-meaning`, label: `${norm} meaning`, hintEmbedding: [], meta: { synthetic: true } },
        { id: `${baseId}-related`, label: `${norm} related`, hintEmbedding: [], meta: { synthetic: true } },
        { id: `${baseId}-context`, label: `${norm} context`, hintEmbedding: [], meta: { synthetic: true } },
      ],
      edges: [
        { src: baseId, dst: `${baseId}-meaning`, weight: 0.9, role: 'instance' },
        { src: baseId, dst: `${baseId}-related`, weight: 0.7, role: 'analogy' },
        { src: baseId, dst: `${baseId}-context`, weight: 0.6, role: 'cause' },
      ],
      notes: `Stub adjacency for ${norm}`,
    };
  }

  async expandAdjacencyToken(token: string): Promise<AdjacencyDelta> {
    const norm = token.trim() || 'token';
    const baseId = norm.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'token';
    return {
      nodes: [
        { id: `${baseId}-a`, label: `${norm} a`, hintEmbedding: [], meta: { synthetic: true } },
        { id: `${baseId}-b`, label: `${norm} b`, hintEmbedding: [], meta: { synthetic: true } },
      ],
      edges: [
        { src: baseId, dst: `${baseId}-a`, weight: 0.6, role: 'contrast' },
        { src: baseId, dst: `${baseId}-b`, weight: 0.55, role: 'meta' },
      ],
      notes: `Stub expand adjacency for ${norm}`,
    };
  }

  async articulateResponse(
    _articulation: ArticulationEvent,
    userQuestion: string,
    salientContext?: { tokens: string[]; summary: string },
  ): Promise<string> {
    // TODO: Wire into actual LLM call with prompt:
    //
    // SYSTEM:
    //  You are an explainer sitting on top of a cognitive graph...
    //
    // USER:
    //  {
    //    "user_question": "...",
    //    "articulation_event": { ... }
    //  }
    //
    // Return natural language answer.
    const contextSuffix = salientContext
      ? ` Salient tokens: ${salientContext.tokens.join(', ')}. Summary: ${salientContext.summary}`
      : '';
    return `Stubbed response to: ${userQuestion}.${contextSuffix}`;
  }
}
