import {
  type CharacterSetName,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  passwordEntropyBits,
} from '@blindvault/crypto';
import { useState } from 'react';

import {
  type GeneratorSettings,
  loadGeneratorSettings,
  saveGeneratorSettings,
} from '../app/generator-settings';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Field, TARGET } from './components';

const SETS: readonly CharacterSetName[] = ['lowercase', 'uppercase', 'digits', 'symbols'];

/** The entropy of `s` in bits, or `null` below the minimums (D128): then nothing is offered. */
function entropy(s: GeneratorSettings): number | null {
  try {
    return s.mode === 'words'
      ? passphraseEntropyBits(s.words)
      : passwordEntropyBits(s.length, s.sets);
  } catch {
    return null;
  }
}

/**
 * The password generator of the item editor (overview §13.6). The generated value goes straight
 * into the field being edited; only the settings are kept.
 */
export function Generator({ onUse }: { readonly onUse: (value: string) => void }) {
  const m = useMessages();
  const [settings, setSettings] = useState(loadGeneratorSettings);
  // Counts typed as text, so a value can be typed through an invalid one.
  const [length, setLength] = useState(String(settings.length));
  const [words, setWords] = useState(String(settings.words));
  const update = (next: GeneratorSettings) => {
    setSettings(next);
    if (entropy(next) !== null) saveGeneratorSettings(next);
  };
  const bits = entropy(settings);
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex gap-4 text-sm" role="radiogroup">
        {(['characters', 'words'] as const).map((mode) => (
          <label key={mode} className={`${TARGET} flex items-center gap-2`}>
            <input
              type="radio"
              name="generator-mode"
              checked={settings.mode === mode}
              onChange={() => {
                update({ ...settings, mode });
              }}
            />
            {m.generator[mode]}
          </label>
        ))}
      </div>
      {settings.mode === 'characters' ? (
        <>
          <Field
            label={m.generator.length}
            inputMode="numeric"
            value={length}
            onChange={(e) => {
              setLength(e.target.value);
              update({ ...settings, length: Number(e.target.value) });
            }}
          />
          <div className="flex flex-wrap gap-4 text-sm">
            {SETS.map((set) => (
              <label key={set} className={`${TARGET} flex items-center gap-2`}>
                <input
                  type="checkbox"
                  checked={settings.sets.includes(set)}
                  onChange={(e) => {
                    const sets = e.target.checked
                      ? SETS.filter((s) => s === set || settings.sets.includes(s))
                      : settings.sets.filter((s) => s !== set);
                    update({ ...settings, sets });
                  }}
                />
                {m.generator[set]}
              </label>
            ))}
          </div>
        </>
      ) : (
        <Field
          label={m.generator.wordCount}
          inputMode="numeric"
          value={words}
          onChange={(e) => {
            setWords(e.target.value);
            update({ ...settings, words: Number(e.target.value) });
          }}
        />
      )}
      <p className="text-sm text-zinc-500" data-testid="generator-entropy">
        {bits === null
          ? m.generator.unavailable
          : format(m.generator.entropy, { bits: String(Math.floor(bits)) })}
      </p>
      <Button
        disabled={bits === null}
        onClick={() => {
          const generated =
            settings.mode === 'words'
              ? generatePassphrase(settings.words)
              : generatePassword(settings.length, settings.sets);
          onUse(generated.value);
        }}
      >
        {m.generator.use}
      </Button>
    </fieldset>
  );
}
