import { bridgeStatusView } from "./bridge-status.js";

const status = document.querySelector("#bridge-status");
const title = document.querySelector("#bridge-title");
const detail = document.querySelector("#bridge-detail");
const checkedAt = document.querySelector("#bridge-checked-at");
const retry = document.querySelector("#bridge-retry");

async function checkBridge() {
  retry.disabled = true;
  status.className = "status checking";
  title.textContent = "正在检查桌面连接…";
  detail.textContent = "";
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "check-bridge" });
  } catch (error) {
    result = { ok: false, error: error?.message ?? "unknown-error" };
  }
  const view = bridgeStatusView(result);
  status.className = `status ${view.tone}`;
  title.textContent = view.title;
  detail.textContent = view.detail;
  checkedAt.textContent = `检查于 ${new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
  retry.disabled = false;
}

retry.addEventListener("click", checkBridge);
await checkBridge();
