export function App() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <h1 className="text-3xl font-semibold">BlindVault</h1>
      <p className="text-sm text-zinc-500">v{__APP_VERSION__}</p>
    </main>
  );
}
