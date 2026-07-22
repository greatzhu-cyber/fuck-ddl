import { invoke } from "@tauri-apps/api/core";
import { isTauriDesktop } from "./integrations/pintia-desktop.js";

export async function saveDesktopBackup(
  document,
  { invokeCommand = invoke } = {},
) {
  if (!isTauriDesktop()) return false;
  const backupJson = JSON.stringify(document);
  if (backupJson.length > 2 * 1024 * 1024) return false;
  await invokeCommand("save_local_backup", { backupJson });
  return true;
}
