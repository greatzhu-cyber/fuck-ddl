import { describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({ active: false }));

vi.mock("./integrations/pintia-desktop.js", () => ({
  isTauriDesktop: () => desktop.active,
}));

import { saveDesktopBackup } from "./desktop-backup.js";

describe("desktop backup bridge", () => {
  it("never writes a backup from the web build", async () => {
    desktop.active = false;
    const invokeCommand = vi.fn();
    await expect(
      saveDesktopBackup({ state: {} }, { invokeCommand }),
    ).resolves.toBe(false);
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("sends only a bounded serialized document to the desktop command", async () => {
    desktop.active = true;
    const invokeCommand = vi.fn().mockResolvedValue("backup.json");
    await expect(
      saveDesktopBackup(
        { format: "fuck-ddl-backup", version: 1, state: {} },
        { invokeCommand },
      ),
    ).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith("save_local_backup", {
      backupJson: '{"format":"fuck-ddl-backup","version":1,"state":{}}',
    });
  });
});
