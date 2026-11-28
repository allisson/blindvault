import { useMessages } from '../i18n/context';
import { Brand, CardMark, TARGET } from './components';

/** The only screen of an app running inside a frame (D83, D193), as a card (D316). */
export function Framed() {
  const m = useMessages();
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-fg">
      <main className="flex flex-1 flex-col sm:items-center sm:justify-center sm:p-4">
        <section
          data-testid="framed"
          className="flex w-full flex-col gap-4 p-6 sm:max-w-[32.5rem] sm:rounded-card sm:border sm:border-line sm:bg-raised sm:p-8 sm:shadow-raised"
        >
          <Brand preview={false} />
          <CardMark name="app-window" tone="warning" />
          <h1 className="text-title">{m.framed.title}</h1>
          <p className="text-muted">{m.framed.body}</p>
          <a
            href={`${location.origin}/`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${TARGET} inline-flex items-center self-start rounded-control bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent-hover`}
          >
            {m.framed.open}
          </a>
        </section>
      </main>
    </div>
  );
}
