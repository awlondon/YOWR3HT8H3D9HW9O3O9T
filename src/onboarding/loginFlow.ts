export interface LoginFormOptions {
  finalizeOnboarding: (level: string, details: Record<string, unknown>) => void;
  membershipLevels: { MEMBER: string } & Record<string, string>;
}

function readControlValue(form: HTMLFormElement, name: string): string {
  if (!form || !name) return '';
  const elements = form.elements;
  if (elements && typeof elements.namedItem === 'function') {
    const control = elements.namedItem(name);
    if (control && typeof (control as HTMLInputElement).value === 'string') {
      return ((control as HTMLInputElement).value || '').trim();
    }
  }
  if (typeof form.querySelector === 'function') {
    const fallback = form.querySelector(`[name="${name}"]`);
    if (fallback && typeof (fallback as HTMLInputElement).value === 'string') {
      return ((fallback as HTMLInputElement).value || '').trim();
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
    finalize(membershipLevels.MEMBER, {
      email,
      name: email,
      plan: 'pro',
    });
  };

  form.addEventListener('submit', handler);
  return () => {
    form.removeEventListener('submit', handler);
  };
}
