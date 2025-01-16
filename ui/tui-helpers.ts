import {
  ComponentState,
  Signal,
  Theme,
} from "https://deno.land/x/tui@2.1.11/mod.ts";

export const disableComponent = (
  component: { state: Signal<keyof Theme> },
): AbortController => {
  const initialState = component.state.value;
  component.state.value = "disabled";
  const abortController = new AbortController();
  component.state.subscribe((x) => {
    if (x !== "disabled") {
      component.state.value = "disabled";
    }
  }, abortController.signal);
  abortController.signal.addEventListener("abort", () => {
    component.state.value = initialState;
  });

  return abortController;
};

export const keepComponentFocussed = (
  input: { state: Signal<ComponentState> },
) => {
  if (input.state.value !== "focused") {
    input.state.value = "focused";
  }
  input.state.subscribe((x) => {
    if (x !== "focused") {
      input.state.value = "focused";
    }
  });
};
