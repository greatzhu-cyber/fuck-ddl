export function bridgeStatusView(result) {
  if (result?.ok) {
    return {
      tone: "connected",
      title: "桌面端连接正常",
      detail: "专注时，非白名单网站连续停留 10 分钟会触发暂停。",
    };
  }
  const error = String(result?.error ?? "").toLowerCase();
  if (
    /native messaging host.*not found|specified native messaging host/.test(
      error,
    )
  ) {
    return {
      tone: "disconnected",
      title: "Native Host 未注册",
      detail: "重新运行项目的 Edge Host 安装脚本，然后回到这里检查。",
    };
  }
  if (
    /could not establish connection|desktop-unavailable|connection refused/.test(
      error,
    )
  ) {
    return {
      tone: "disconnected",
      title: "桌面端尚未运行",
      detail: "先打开 Fuck DDL，再点击“重新检查”。期间不会丢弃或上传浏览记录。",
    };
  }
  return {
    tone: "disconnected",
    title: "连接检查失败",
    detail: "检查扩展权限与桌面应用状态后重试。",
  };
}
