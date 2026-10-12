// Password strength: zxcvbn score 4 for the local password (D71), an estimated 10^14 guesses for
// the export password (D134, D155). The dictionaries load on first use, so the app shell does not
// carry them. A strength check is not cryptographic protection.

import { type Generated } from '@blindvault/crypto';

import { type Language } from '../i18n/messages';

export interface Strength {
  readonly score: 0 | 1 | 2 | 3 | 4;
  /** Whether it is acceptable as a local password. */
  readonly acceptable: boolean;
  readonly warning: string;
  /** zxcvbn's estimate of the guesses needed. */
  readonly guesses: number;
}

/** The export password threshold (D134): a backup can be attacked offline wherever it is copied. */
export const EXPORT_GUESSES = 1e14;
export const EXPORT_ENTROPY_BITS = Math.log2(EXPORT_GUESSES);

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
      guesses: result.guesses,
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

export interface ExportStrength {
  readonly acceptable: boolean;
  readonly warning: string;
  /** Judged by the generator's exact entropy, not by zxcvbn (D155). */
  readonly generated: boolean;
}

/**
 * The export password check. A passphrase taken unchanged from the generator is judged by its exact
 * entropy, since zxcvbn can rate common BIP39 words lower and would reject the UI's own suggestion
 * (D155); once edited, zxcvbn's guess estimate applies (D134).
 */
export async function exportStrength(
  language: Language,
  password: string,
  generated?: Generated,
): Promise<ExportStrength> {
  if (generated?.value === password) {
    return {
      acceptable: generated.entropyBits >= EXPORT_ENTROPY_BITS,
      warning: '',
      generated: true,
    };
  }
  const strength = (await estimator(language))(password);
  return {
    acceptable: strength.guesses >= EXPORT_GUESSES,
    warning: strength.warning,
    generated: false,
  };
}
