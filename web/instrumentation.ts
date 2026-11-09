export async function register(): Promise<void> {
  // Node.js only (SQLite, argon2, process.exit); the Edge build of this file drops the import.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startServer } = await import("./lib/startup");
    await startServer();
  }
}
