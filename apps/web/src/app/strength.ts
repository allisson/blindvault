// Local password strength (D71): zxcvbn score 4. The dictionaries load on first use, so the app
// shell does not carry them. A strength check is not cryptographic protection.

import { type Language } from '../i18n/messages';

export interface Strength {
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly acceptable: boolean;
  readonly warning: string;
}

export const REQUIRED_SCORE = 4;

type Estimator = (password: string) => Strength;

const estimators = new Map<Language, Promise<Estimator>>();

async function load(language: Language): Promise<Estimator> {
  const [core, common, en, pt] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
    import('@zxcvbn-ts/language-pt-br'),
  ]);
  const options = {
    translations: language === 'pt-BR' ? pt.translations : en.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary, ...pt.dictionary },
  };
  return (password) => {
    // One options object per call: zxcvbn-ts 3 keeps its options globally.
    core.zxcvbnOptions.setOptions(options);
    const result = core.zxcvbn(password);
    const score = result.score;
    return {
      score,
      acceptable: score >= REQUIRED_SCORE,
      warning: result.feedback.warning ?? '',
    };
  };
}

export function estimator(language: Language): Promise<Estimator> {
  let e = estimators.get(language);
  if (!e) {
    e = load(language);
    estimators.set(language, e);
  }
  return e;
}
