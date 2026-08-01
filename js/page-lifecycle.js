export function shouldDestroySensorsOnPageHide(event) {
  return event?.persisted !== true;
}
