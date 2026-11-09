export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.GATEWAY_CONTROL_SECRET?.trim()) {
    console.warn("[config] GATEWAY_CONTROL_SECRET is empty; calls to the gateway control API will be rejected.");
  }
  const { seedAdmin } = await import("./lib/seed");
  await seedAdmin();
}
