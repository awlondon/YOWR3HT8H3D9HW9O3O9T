import type { AgentContext, AgentPlan } from '../types';

export async function selfQueryLLM(ctx: AgentContext): Promise<AgentPlan | null> {
  if (!ctx.llm) return null;

  const summary = JSON.stringify({
    metrics: ctx.state.metrics,
    lastPrompt: ctx.state.prompt,
    historyTail: ctx.state.history.slice(-5),
  });

  const query = `Given state: ${summary}\nPropose the SINGLE next prompt to advance understanding. Respond with only the prompt.`;
  const output = (await ctx.llm(query)).trim().replace(/^"|"$/g, '');
  if (!output) return null;

  return {
    prompt: output,
    rationale: 'LLM self-query based on current metrics.',
  };
}
