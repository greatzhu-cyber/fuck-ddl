export function shouldSendAttentionNotification({
  hidden = document.hidden,
  focused = document.hasFocus?.() ?? true,
} = {}) {
  return hidden || !focused;
}

export async function sendSilentNotification(title, body) {
  if (!shouldSendAttentionNotification()) return false;

  if (window.__TAURI_INTERNALS__) {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import("@tauri-apps/plugin-notification");
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) return false;
      sendNotification({ title, body, silent: true });
      return true;
    } catch {
      return false;
    }
  }

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    new Notification(title, { body, silent: true });
    return true;
  }
  return false;
}
