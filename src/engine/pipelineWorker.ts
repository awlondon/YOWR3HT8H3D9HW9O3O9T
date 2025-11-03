import { runPipeline, type PipelineResult } from './pipeline';
import type { Settings } from '../settings';
import { computeEmbeddingsFromPipeline } from './vectorSemantics';

interface RunPipelineRequest {
  id: number;
  type: 'runPipeline';
  text: string;
  settings: Settings;
}

interface RunPipelineResponse {
  id: number;
  type: 'runPipeline';
  result?: PipelineResult;
  embeddings?: ReturnType<typeof computeEmbeddingsFromPipeline>;
  error?: string;
}

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<RunPipelineRequest>) => {
  const data = event.data;
  if (!data || data.type !== 'runPipeline') {
    return;
  }

  try {
    const result = runPipeline(data.text, data.settings);
    const embeddings = computeEmbeddingsFromPipeline(result);
    const response: RunPipelineResponse = {
      id: data.id,
      type: 'runPipeline',
      result,
      embeddings,
    };
    self.postMessage(response);
  } catch (error) {
    const response: RunPipelineResponse = {
      id: data.id,
      type: 'runPipeline',
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
