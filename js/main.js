import { STATES, transition } from "./router.js";

const screens = new Map(
  [...document.querySelectorAll("[data-screen]")].map((screen) => [
    screen.dataset.screen,
    screen,
  ]),
);

let currentState = "enable";
let lap = 1;

function render(nextState, { moveFocus = true } = {}) {
  currentState = nextState;

  for (const state of STATES) {
    const screen = screens.get(state);
    if (!screen) {
      throw new Error(`Missing screen markup for state: ${state}`);
    }

    const isActive = state === currentState;
    screen.hidden = !isActive;
    screen.setAttribute("aria-hidden", String(!isActive));
  }

  if (moveFocus) {
    screens.get(currentState)?.querySelector("h1")?.focus({ preventScroll: true });
  }
}

function dispatch(event) {
  const nextState = transition(currentState, event);
  render(nextState);
}

document.querySelector('[data-action="enable"]').addEventListener("click", () => {
  // The sensor implementation will request motion and location here. This shell
  // deliberately preserves the required user gesture and only advances routing.
  dispatch("ENABLE");
});

document.querySelector('[data-action="zero"]').addEventListener("click", () => {
  // Capturing the physical zero reference belongs to the sensor implementation.
  dispatch("ZERO");
});

document.querySelector('[data-action="start-race"]').addEventListener("click", () => {
  lap = 1;
  document.querySelector("[data-lap-number]").textContent = String(lap);
  dispatch("START_RACE");
});

document.querySelector('[data-action="complete-lap"]').addEventListener("click", () => {
  lap += 1;
  document.querySelector("[data-lap-number]").textContent = String(lap);
  dispatch("NEXT_LAP");
});

document.querySelector('[data-action="end-race"]').addEventListener("click", (event) => {
  event.stopPropagation();
  dispatch("END_RACE");
});

document.querySelector('[data-action="new-run"]').addEventListener("click", () => {
  dispatch("NEW_RUN");
});

document.querySelector('[data-action="continue-limited"]').addEventListener("click", () => {
  dispatch("CONTINUE_LIMITED");
});

render(currentState, { moveFocus: false });
