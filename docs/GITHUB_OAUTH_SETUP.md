# GitHub 登录配置

本项目的 GitHub 登录由 Supabase Auth 处理，客户端只使用项目 URL 与 publishable key；GitHub Client Secret 与 Supabase service-role key 只能留在对应管理后台，不能写入仓库、安装包或 `.env.example`。

## 管理员一次性配置

1. 创建 Supabase 项目，在 SQL Editor 执行 `supabase/migrations/20260707000100_core.sql`。
2. 在 Supabase Auth 的 Hooks 中启用 Postgres `Before User Created` Hook，选择 `public.hook_restrict_github_signup`。
3. 在 GitHub Developer Settings 创建 OAuth App。回调 URL 填 Supabase GitHub 登录页面提供的 callback URL，不填 Fuck DDL 的网页地址。
4. 在 Supabase Auth > Providers > GitHub 填入 GitHub OAuth App 的 Client ID 与 Client Secret，并启用 GitHub。
5. 在 Supabase Auth > URL Configuration 中设置 Site URL，并将网页的 `https://你的域名/auth/callback` 加入 Redirect URLs。
6. 在 `public.github_allowlist` 添加用户的 GitHub **数字 ID**，而不是可变的用户名：

   ```sql
   insert into public.github_allowlist (github_user_id, github_login, note)
   values (12345678, 'your-github-login', 'initial administrator');
   ```

7. 复制 `apps/web/.env.example` 为 `apps/web/.env.local`，填入项目 URL、publishable key 和网页 callback URL。`.env.local` 已被忽略，不会提交。

## 验收

1. 用允许名单内的 GitHub 账号打开网页，点击右上角 GitHub 图标，再点“使用 GitHub 登录”。
2. GitHub 授权后回到 `/auth/callback`，账户菜单应显示 GitHub 用户名。
3. 用未允许账号重复操作，注册应被注册前 Hook 拒绝，且不会生成 `auth.users` 记录。
4. 点击“退出登录”，刷新页面确认该网页会话已退出。

## 当前边界

网页端 OAuth 已按 PKCE 接入。桌面端仍须增加 Tauri 深链接回调和本机安全存储后，才能安全地保留 GitHub 会话；在此之前桌面端会明确提示改在网页端登录，而不会假装登录成功。
