import { invoke } from "@tauri-apps/api/core";
import { isTauriDesktop } from "./pintia-desktop.js";

export async function setEdgeFocusActive(active) {
  if (!isTauriDesktop()) return false;
  await invoke("set_edge_focus_active", { active: Boolean(active) });
  return true;
}
