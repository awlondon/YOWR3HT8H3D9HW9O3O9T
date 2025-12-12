const pronouns = [' my ', ' i ', ' i\'m ', " i'm ", ' me ', ' mine '];

function normalize(text: string): string {
  return ` ${text.trim()} `.toLowerCase();
}

export function anchorPronouns(thoughts: string[], anchors: string[]): string[] {
  if (!anchors.length) return thoughts;
  const primary = anchors.find((token) => /[A-Z]/.test(token)) || anchors[0];
  return thoughts.map((thought) => {
    const lower = normalize(thought);
    const hasPronoun = pronouns.some((p) => lower.includes(p));
    if (!hasPronoun || !primary) return thought;
    return thought.replace(/\b(I|i|my|My|me|Mine)\b/g, primary);
  });
}
