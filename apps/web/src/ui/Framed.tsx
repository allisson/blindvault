import { useMessages } from '../i18n/context';

/** The only screen of an app running inside a frame (D83, D193). */
export function Framed() {
  const m = useMessages();
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-fg">
      <main className="flex flex-1 items-center justify-center p-4">
        <section
          data-testid="framed"
          className="flex w-full max-w-sm flex-col gap-4 rounded-card bg-raised p-6 shadow-raised"
        >
          <span className="text-sm font-semibold">{m.app.name}</span>
          <h1 className="text-title">{m.framed.title}</h1>
          <p>{m.framed.body}</p>
          <a
            href={`${location.origin}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start underline"
          >
            {m.framed.open}
          </a>
        </section>
      </main>
    </div>
  );
}
