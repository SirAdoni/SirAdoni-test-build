import { useUIStore } from "../stores/ui.store";

/** Open the fantasy name generator from anywhere: a menu, a toolbar or a command. */
export function openNameGenerator() {
  useUIStore.getState().openModal("name-generator");
}
