import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  githubIdentity,
  readSupabaseConfig,
  resolveAuthRedirectUrl,
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
});
