import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';

import { LANGUAGES, type Language, MESSAGES, type Messages, pickLanguage } from './messages';

// The language is a non-sensitive UI preference, the one kind `localStorage` may hold (overview §7).
const STORAGE_KEY = 'blindvault.language';

function stored(): Language | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.find((l) => l === value);
  } catch {
    return undefined;
  }
}

interface LanguageState {
  readonly language: Language;
  readonly messages: Messages;
  readonly setLanguage: (language: Language) => void;
}

const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { readonly children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(
    () => stored() ?? pickLanguage(navigator.languages),
  );
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // storage unavailable: the choice lasts for this app window
    }
  }, [language]);
  return (
    <LanguageContext value={{ language, messages: MESSAGES[language], setLanguage }}>
      {children}
    </LanguageContext>
  );
}

export function useLanguage(): LanguageState {
  const state = useContext(LanguageContext);
  if (!state) throw new Error('LanguageProvider missing');
  return state;
}

export function useMessages(): Messages {
  return useLanguage().messages;
}
