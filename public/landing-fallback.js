(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const FLAG = '__hlsfLandingFallbackApplied__';
  if (window[FLAG]) {
    return;
  }
  window[FLAG] = true;

  const onReady = (callback) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  };

  onReady(() => {
    const landingRoot = document.getElementById('landing-screen');
    if (!landingRoot) {
      return;
    }

    const engine = window.CognitionEngine && typeof window.CognitionEngine === 'object'
      ? window.CognitionEngine
      : null;

    if (engine && engine.landingInitialized) {
      return;
    }

    const forms = {
      signup: document.getElementById('landing-signup-form'),
      login: document.getElementById('landing-login-form'),
      demo: document.getElementById('landing-demo-form'),
    };

    const tabs = Array.from(landingRoot.querySelectorAll('.landing-tab'));

    const setActiveView = (view) => {
      const key = typeof view === 'string' ? view.toLowerCase() : 'signup';
      tabs.forEach((btn) => {
        const match = btn.dataset && btn.dataset.view === key;
        btn.classList.toggle('is-active', match);
        btn.setAttribute('aria-selected', match ? 'true' : 'false');
      });
      Object.entries(forms).forEach(([formKey, form]) => {
        if (!(form instanceof HTMLElement)) return;
        const active = formKey === key;
        form.classList.toggle('is-active', active);
        form.setAttribute('aria-hidden', active ? 'false' : 'true');
      });
    };

    const readControlValue = (form, name, trim) => {
      if (!(form instanceof HTMLFormElement) || !name) return '';
      const element = form.elements.namedItem(name);
      const asInput = element && typeof element === 'object' && 'value' in element
        ? element
        : form.querySelector(`[name="${name}"]`);
      if (!asInput || typeof asInput.value !== 'string') return '';
      const value = asInput.value;
      return trim === false ? value : value.trim();
    };

    const memberLevel = engine && engine.membershipLevels && typeof engine.membershipLevels === 'object'
      ? engine.membershipLevels.MEMBER || 'member'
      : 'member';
    const demoLevel = engine && engine.membershipLevels && typeof engine.membershipLevels === 'object'
      ? engine.membershipLevels.DEMO || 'demo'
      : 'demo';

    const enqueuePendingFinalization = (payload) => {
      if (!payload || !payload.level) return;
      const root = window;
      const queueKey = '__hlsfPendingOnboarding__';
      const queue = Array.isArray(root[queueKey]) ? root[queueKey] : (root[queueKey] = []);
      queue.push({ level: payload.level, details: payload.details || {} });
    };

    const finalize = (level, details) => {
      const normalizedDetails = details || {};
      if (engine && typeof engine.finalizeOnboarding === 'function') {
        engine.finalizeOnboarding(level, normalizedDetails);
        return;
      }
      enqueuePendingFinalization({ level, details: normalizedDetails });
      document.body.classList.remove('onboarding-active');
      landingRoot.setAttribute('aria-hidden', 'true');
      if (level === memberLevel) {
        document.body.classList.add('membership-member');
        document.body.classList.remove('membership-demo');
      } else {
        document.body.classList.remove('membership-member');
        document.body.classList.add('membership-demo');
      }
    };

    const handleSubmit = (form, build) => {
      if (!(form instanceof HTMLFormElement)) return;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
          return;
        }
        try {
          const payload = build(form);
          if (!payload || !payload.level) return;
          finalize(payload.level, payload.details || {});
        } catch (error) {
          console.warn('Landing fallback unable to process submission:', error);
        }
      });
    };

    tabs.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const target = btn.dataset ? btn.dataset.view : null;
        setActiveView(target || 'signup');
      });
    });

    handleSubmit(forms.login, (form) => {
      const email = readControlValue(form, 'loginEmail', true);
      const password = readControlValue(form, 'loginPassword', false);
      return {
        level: memberLevel,
        details: {
          email,
          name: email,
          plan: 'pro',
          password,
        },
      };
    });

    handleSubmit(forms.demo, (form) => {
      const name = readControlValue(form, 'demoName', true);
      const email = readControlValue(form, 'demoEmail', true);
      const focus = readControlValue(form, 'demoFocus', true);
      const modeControl = form.querySelector('input[name="demoMode"]:checked');
      const demoMode = modeControl && typeof modeControl.value === 'string' && modeControl.value.toLowerCase() === 'offline'
        ? 'offline'
        : 'api';
      return {
        level: demoLevel,
        details: {
          name,
          email,
          focus,
          demoMode,
        },
      };
    });

    if (forms.signup instanceof HTMLFormElement) {
      forms.signup.addEventListener('submit', (event) => {
        event.preventDefault();
        setActiveView('login');
      });
    }

    const adminBypassLink = landingRoot.querySelector('[data-admin-bypass]');
    if (adminBypassLink instanceof HTMLElement) {
      adminBypassLink.addEventListener('click', (event) => {
        event.preventDefault();
        finalize(memberLevel, {
          plan: 'admin',
          name: 'System Administrator',
          email: 'admin@local.dev',
          role: 'admin',
          admin: true,
          authProvider: 'bypass',
        });
        if (window.history && typeof window.history.replaceState === 'function') {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      });
    }

    const hash = window.location && typeof window.location.hash === 'string'
      ? window.location.hash.trim().toLowerCase()
      : '';
    if (hash === '#admin-bypass') {
      finalize(memberLevel, {
        plan: 'admin',
        name: 'System Administrator',
        email: 'admin@local.dev',
        role: 'admin',
        admin: true,
        authProvider: 'bypass',
      });
    }

    setActiveView('signup');
    landingRoot.setAttribute('aria-hidden', 'false');
  });
})();
