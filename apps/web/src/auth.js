import { createClient } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const AUTH_STORAGE_KEY = "fuck-ddl:auth";
let browserClient = null;

export function readSupabaseConfig(env = import.meta.env) {
  const url = String(env?.VITE_SUPABASE_URL ?? "").trim();
  const publishableKey = String(
    env?.VITE_SUPABASE_PUBLISHABLE_KEY ?? env?.VITE_SUPABASE_ANON_KEY ?? "",
  ).trim();
  const redirectUrl = String(env?.VITE_AUTH_REDIRECT_URL ?? "").trim();
  if (!url || !publishableKey) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
  } catch {
    return null;
  }
  return { url, publishableKey, redirectUrl };
}

export function isDesktopAuthRuntime(windowObject = window) {
  return Boolean(windowObject?.__TAURI_INTERNALS__);
}

export function resolveAuthRedirectUrl(
  config,
  locationObject = window.location,
) {
  if (config?.redirectUrl) return config.redirectUrl;
  return locationObject?.origin ?? "";
}

export function getSupabaseAuthClient({
  env = import.meta.env,
  windowObject = window,
  create = createClient,
} = {}) {
  const config = readSupabaseConfig(env);
  if (!config) return null;
  if (browserClient) return browserClient;
  const desktop = isDesktopAuthRuntime(windowObject);
  browserClient = create(config.url, config.publishableKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      detectSessionInUrl: !desktop,
      autoRefreshToken: true,
      storageKey: AUTH_STORAGE_KEY,
    },
  });
  return browserClient;
}

export function resetSupabaseAuthClientForTests() {
  browserClient = null;
}

export function githubIdentity(user) {
  const identity = user?.identities?.find((item) => item.provider === "github");
  const data = identity?.identity_data ?? {};
  return {
    id: String(data.provider_id ?? data.user_id ?? data.id ?? ""),
    login: String(
      data.user_name ?? data.login ?? user?.user_metadata?.user_name ?? "",
    ),
    avatarUrl: String(data.avatar_url ?? user?.user_metadata?.avatar_url ?? ""),
  };
}

export async function signInWithGithub(
  client,
  {
    config,
    locationObject = window.location,
    desktop = isDesktopAuthRuntime(),
    desktopBridge = { invoke, listen },
  } = {},
) {
  if (!client) throw new Error("Supabase 登录尚未配置。");
  if (desktop) {
    const redirectUrl = await desktopBridge.invoke(
      "start_desktop_oauth_callback",
    );
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: redirectUrl, skipBrowserRedirect: true },
    });
    if (error) throw error;
    if (!data?.url) throw new Error("Supabase 未返回 GitHub 登录地址。");
    let unlisten = null;
    try {
      const callback = new Promise((resolve, reject) => {
        let timer = null;
        const finish = (handler, value) => {
          if (timer) window.clearTimeout(timer);
          handler(value);
        };
        void desktopBridge
          .listen("fuck-ddl:desktop-oauth-callback", (event) => {
            finish(resolve, event?.payload ?? {});
          })
          .then((stop) => {
            unlisten = stop;
          })
          .catch(reject);
        timer = window.setTimeout(
          () => finish(reject, new Error("GitHub 登录等待超时，请重试。")),
          5 * 60 * 1000,
        );
      });
      await desktopBridge.invoke("open_external_url", { url: data.url });
      const result = await callback;
      if (result.error) {
        throw new Error(result.error_description || result.error);
      }
      if (!result.code) throw new Error("GitHub 登录未返回授权 code。");
      const { error: exchangeError } = await client.auth.exchangeCodeForSession(
        result.code,
      );
      if (exchangeError) throw exchangeError;
    } finally {
      if (unlisten) unlisten();
    }
    return;
  }
  const { error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: resolveAuthRedirectUrl(config, locationObject) },
  });
  if (error) throw error;
}

export function authErrorMessage(error) {
  const message = String(error?.message ?? error ?? "登录失败，请稍后重试。");
  if (/not invited|not allow|forbidden|403/i.test(message)) {
    return "这个 GitHub 账号不在允许名单中。";
  }
  if (/redirect/i.test(message)) {
    return "OAuth 回调地址未获允许，请检查 Supabase 的 Redirect URLs。";
  }
  return message;
}
