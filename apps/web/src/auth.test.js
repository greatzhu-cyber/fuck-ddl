import { describe, expect, it, vi } from "vitest";
import {
  authErrorMessage,
  githubIdentity,
  readSupabaseConfig,
  resolveAuthRedirectUrl,
  signInWithGithub,
} from "./auth.js";

describe("Supabase GitHub authentication helpers", () => {
  it("requires both a project URL and publishable key", () => {
    expect(readSupabaseConfig({})).toBeNull();
    expect(
      readSupabaseConfig({
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      }),
    ).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
      redirectUrl: "",
    });
  });

  it("uses the configured OAuth callback before the current origin", () => {
    expect(
      resolveAuthRedirectUrl(
        { redirectUrl: "https://fuck-ddl.example/auth/callback" },
        { origin: "http://localhost:1420" },
      ),
    ).toBe("https://fuck-ddl.example/auth/callback");
  });

  it("extracts immutable GitHub identity and maps allowlist failures", () => {
    expect(
      githubIdentity({
        identities: [
          {
            provider: "github",
            identity_data: {
              provider_id: "1234",
              user_name: "zhu",
              avatar_url: "https://avatars.example/zhu.png",
            },
          },
        ],
      }),
    ).toEqual({
      id: "1234",
      login: "zhu",
      avatarUrl: "https://avatars.example/zhu.png",
    });
    expect(
      authErrorMessage(new Error("This GitHub account is not invited.")),
    ).toBe("这个 GitHub 账号不在允许名单中。");
  });

  it("completes desktop OAuth through the loopback callback", async () => {
    let callbackHandler;
    const bridge = {
      invoke: vi.fn(async (command) => {
        if (command === "start_desktop_oauth_callback") {
          return "http://127.0.0.1:43123/auth/callback";
        }
        callbackHandler({ payload: { code: "oauth-code" } });
      }),
      listen: vi.fn(async (_event, handler) => {
        callbackHandler = handler;
        return vi.fn();
      }),
    };
    const client = {
      auth: {
        signInWithOAuth: vi.fn().mockResolvedValue({
          data: { url: "https://github.com/login/oauth/authorize?state=test" },
          error: null,
        }),
        exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }),
      },
    };

    await signInWithGithub(client, { desktop: true, desktopBridge: bridge });

    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: "http://127.0.0.1:43123/auth/callback",
        skipBrowserRedirect: true,
      },
    });
    expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith(
      "oauth-code",
    );
    expect(bridge.invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/login/oauth/authorize?state=test",
    });
  });
});
