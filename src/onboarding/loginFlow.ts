export interface LoginFormOptions {
  finalizeOnboarding: (level: string, details: Record<string, unknown>) => void;
  membershipLevels: { MEMBER: string } & Record<string, string>;
}

interface ReadControlOptions {
  trim?: boolean;
}

function readControlValue(
  form: HTMLFormElement,
  name: string,
  options: ReadControlOptions = {}
): string {
  const { trim = true } = options;
  if (!form || !name) return '';
  const elements = form.elements;
  if (elements && typeof elements.namedItem === 'function') {
    const control = elements.namedItem(name);
    if (control && typeof (control as HTMLInputElement).value === 'string') {
      const value = (control as HTMLInputElement).value || '';
      return trim ? value.trim() : value;
    }
  }
  if (typeof form.querySelector === 'function') {
    const fallback = form.querySelector(`[name="${name}"]`);
    if (fallback && typeof (fallback as HTMLInputElement).value === 'string') {
      const value = (fallback as HTMLInputElement).value || '';
      return trim ? value.trim() : value;
    }
  }
  return '';
}

export function initializeLoginForm(
  form: HTMLFormElement,
  options: LoginFormOptions
): () => void {
  if (!form || typeof form.addEventListener !== 'function') {
    return () => {};
  }
  const finalize = options?.finalizeOnboarding;
  const membershipLevels = options?.membershipLevels;
  if (typeof finalize !== 'function' || !membershipLevels?.MEMBER) {
    return () => {};
  }

  const handler = (event: Event) => {
    event.preventDefault();
    if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
      return;
    }
    const email = readControlValue(form, 'loginEmail');
    const password = readControlValue(form, 'loginPassword', { trim: false });
    finalize(membershipLevels.MEMBER, {
      email,
      name: email,
      plan: 'pro',
      password,
    });
  };

  form.addEventListener('submit', handler);
  return () => {
    form.removeEventListener('submit', handler);
  };
}
