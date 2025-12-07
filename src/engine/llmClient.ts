/**
 * LLM client abstraction.
 * - expandAdjacency: internal “thinking” step for each ThoughtEvent.
 * - articulateResponse: external response when an ArticulationEvent fires.
 *
 * NOTE: Implementation details depend on how this repo currently calls LLMs.
 * For now, provide method signatures and comments for integration.
 */

import { type ThoughtEvent, type AdjacencyDelta, type ArticulationEvent } from './cognitionTypes.js';

export interface LLMClient {
  expandAdjacency(ev: ThoughtEvent): Promise<AdjacencyDelta>;
  articulateResponse(articulation: ArticulationEvent, userQuestion: string): Promise<string>;
}

export class StubLLMClient implements LLMClient {
  async expandAdjacency(_ev: ThoughtEvent): Promise<AdjacencyDelta> {
    void _ev;
    // TODO: Wire into actual LLM call with prompt:
    //
    // SYSTEM:
    //  You are an adjacency generator for a cognitive graph...
    //
    // USER:
    //  {ThoughtEvent JSON}
    //
    // Return JSON conforming to AdjacencyDelta.
    return { nodes: [], edges: [], notes: 'stubbed' };
  }

  async articulateResponse(
    _articulation: ArticulationEvent,
    userQuestion: string,
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
    return `Stubbed response to: ${userQuestion}`;
  }
}
