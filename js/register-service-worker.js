export const SERVICE_WORKER_URL = "./sw.js";
export const SERVICE_WORKER_SCOPE = "./";

export async function registerServiceWorker(navigatorRef = globalThis.navigator) {
  if (!("serviceWorker" in (navigatorRef ?? {}))) return null;

  const registration = await navigatorRef.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: SERVICE_WORKER_SCOPE,
    updateViaCache: "none",
  });

  // Registration normally schedules an update check. An explicit check also
  // covers long-lived standalone installs, while the active cache remains
  // usable if the update or any of its precache requests fails.
  await registration.update?.();
  return registration;
}
