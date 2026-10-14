import { useMessages } from '../i18n/context';

/** The only screen of an app running inside a frame (D83, D193). */
export function Framed() {
  const m = useMessages();
  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <main className="flex flex-1 items-center justify-center p-4">
        <section
          data-testid="framed"
          className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-white p-6 shadow-sm dark:bg-zinc-900"
        >
          <span className="text-sm font-semibold">{m.app.name}</span>
          <h1 className="text-xl font-semibold">{m.framed.title}</h1>
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
