export interface GoogleProfile {
  id: string;
  name: string;
  email: string;
  givenName: string;
  familyName: string;
  picture: string;
  locale: string;
}

const MOCK_PROFILES: Array<Omit<GoogleProfile, 'id'>> = [
  {
    name: 'Ada Quinn',
    email: 'ada.quinn@example.com',
    givenName: 'Ada',
    familyName: 'Quinn',
    picture: 'https://avatars.dicebear.com/api/initials/AQ.svg?background=%23011&color=%230f7',
    locale: 'en-US',
  },
  {
    name: 'Hiro Tanaka',
    email: 'hiro.tanaka@example.com',
    givenName: 'Hiro',
    familyName: 'Tanaka',
    picture: 'https://avatars.dicebear.com/api/initials/HT.svg?background=%23011&color=%231be',
    locale: 'ja-JP',
  },
  {
    name: 'Lucía Martínez',
    email: 'lucia.martinez@example.com',
    givenName: 'Lucía',
    familyName: 'Martínez',
    picture: 'https://avatars.dicebear.com/api/initials/LM.svg?background=%23011&color=%23f7c',
    locale: 'es-ES',
  },
  {
    name: 'Noah Singh',
    email: 'noah.singh@example.com',
    givenName: 'Noah',
    familyName: 'Singh',
    picture: 'https://avatars.dicebear.com/api/initials/NS.svg?background=%23011&color=%23f95',
    locale: 'en-GB',
  },
];

function selectRandomProfile(): Omit<GoogleProfile, 'id'> {
  const index = Math.floor(Math.random() * MOCK_PROFILES.length);
  return MOCK_PROFILES[index];
}

function createDemoIdentifier(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `demo-${Date.now().toString(36)}-${random}`;
}

export interface DemoGoogleSignInOptions {
  delayMs?: number;
}

export async function demoGoogleSignIn(options: DemoGoogleSignInOptions = {}): Promise<GoogleProfile> {
  const { delayMs } = options;
  const wait = Number.isFinite(delayMs) ? Math.max(0, Number(delayMs)) : 400 + Math.random() * 700;

  return new Promise(resolve => {
    setTimeout(() => {
      const base = selectRandomProfile();
      resolve({
        id: createDemoIdentifier(),
        ...base,
      });
    }, wait);
  });
}
