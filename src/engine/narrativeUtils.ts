import { AdjacencyFamily } from '../types/adjacencyFamilies.js';

type Edge = { source?: string; target?: string; type?: string; family?: AdjacencyFamily };

type NarrativeBeat = {
  beat: string;
  anchors: string[];
};

export function enforceStoryBeats(edges: Edge[]): NarrativeBeat[] {
  const tempoEdges = edges.filter(edge => edge.family === AdjacencyFamily.Temporal || edge.family === AdjacencyFamily.Causal);
  return [
    {
      beat: 'timeline',
      anchors: tempoEdges.slice(0, 4).map(edge => `${edge.source ?? ''}->${edge.target ?? ''}`).filter(Boolean),
    },
  ];
}

export function mirrorAnalogies(edges: Edge[]): string[] {
  const analogues = edges.filter(edge => edge.family === AdjacencyFamily.Analogical);
  return analogues.map(edge => `Mirror arc via ${edge.source ?? '?'} ↔ ${edge.target ?? '?'}`);
}

export function modulateAestheticTone(edges: Edge[]): string {
  const toneEdges = edges.filter(edge => edge.family === AdjacencyFamily.Aesthetic || edge.family === AdjacencyFamily.Communicative);
  const tone = toneEdges.length > 3 ? 'lyrical' : 'minimal';
  return `Apply ${tone} tone; ${toneEdges.length} stylistic cues present.`;
}
