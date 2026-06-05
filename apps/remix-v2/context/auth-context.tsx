import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@remix-run/react";
import { createContextFromHook, useAction, useObservable } from "@livequery/react";
import { WORKER_SERVICES, useService, type AuthAccount, type AuthAccountState, type AuthApiResponseSession, type AuthSession } from "@/hooks/useWorkerService";
import type { PasskeyCredentialJSON, PasskeyLoginOptions, PasskeyRegistrationOptions } from "@/helpers/passkey-browser";

type ActionError = {
  code: string;
  message: string;
};

/** Chuẩn hoá email để so khớp an toàn (tránh lệch hoa/thường, khoảng trắng). */
export function normalizeEmail(email?: string | null): string {
  return (email ?? "").trim().toLowerCase();
}

function readAuthUsername(account: AuthAccount | null): string {
  return typeof account?.username === "string" ? account.username.trim() : "";
}

function readLegacyEmail(account: AuthAccount | null): string {
  return account && "email" in account ? normalizeEmail(account.email) : "";
}

type AsyncAction<T extends (...args: any[]) => Promise<any>> = T & {
  loading: boolean;
  data?: Awaited<ReturnType<T>>;
  error?: ActionError;
};

type AuthState = {
  ready: boolean;
  currentAccount: AuthAccount | null;
  currentEmail: string;
  currentDisplayName: string;
  authenticated: boolean;
  login: AsyncAction<(session: AuthApiResponseSession | AuthSession) => Promise<void>>;
  logout: AsyncAction<() => Promise<void>>;
  refresh: AsyncAction<() => Promise<AuthSession | null>>;
  getJwtToken: AsyncAction<() => Promise<string | null>>;
  beginPasskeyRegistration: AsyncAction<(username: string) => Promise<PasskeyRegistrationOptions>>;
  finishPasskeyRegistration: AsyncAction<(username: string, credential: PasskeyCredentialJSON) => Promise<AuthSession>>;
  beginPasskeyLogin: AsyncAction<() => Promise<PasskeyLoginOptions>>;
  finishPasskeyLogin: AsyncAction<(credential: PasskeyCredentialJSON) => Promise<AuthSession>>;
};

export const [useAuth, AuthProvider] = createContextFromHook(()  => {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useService(WORKER_SERVICES.auth);
  // Truyền HÀM cho useObservable để nó lazy-resolve `auth.account$` đúng một lần và
  // cache lại (deps []). ServiceLinker trả về proxy MỚI mỗi lần truy cập `.account$`,
  // nên nếu truyền thẳng `auth.account$` thì deps đổi mỗi render → subscribe/unsubscribe
  // liên tục và state kẹt ở emission đầu tiên (loading), không bao giờ nhận được session.
  const observedAccount = useObservable(() => auth.account$, { loading: true }) as AuthAccountState | null;
  const account = observedAccount ?? { loading: true };
  const effectiveSession = account.state ?? null;
  const authenticated = Boolean(effectiveSession?.jwt);
  // Tài khoản hiện tại của phiên (AuthSession chỉ giữ 1 account, không phải list).
  const currentAccount = effectiveSession?.account ?? null;
  // Email (đã chuẩn hoá) của account đang đăng nhập — nguồn duy nhất để các nơi khác
  // (vd nút "Danh sách host", badge header) so khớp.
  const currentEmail = readLegacyEmail(currentAccount);
  const currentDisplayName = readAuthUsername(currentAccount) || currentEmail;
  const onLoginPage = location.pathname === "/auth/login";

  const login = useAction(auth.login);
  const logout = useAction(auth.logout);
  const refresh = useAction(auth.refresh);
  const getJwtToken = useAction(auth.getAccessToken);
  const beginPasskeyRegistration = useAction(auth.beginPasskeyRegistration);
  const finishPasskeyRegistration = useAction(auth.finishPasskeyRegistration);
  const beginPasskeyLogin = useAction(auth.beginPasskeyLogin);
  const finishPasskeyLogin = useAction(auth.finishPasskeyLogin);

  const autoLoginAttempted = useRef(false);
  useEffect(() => {
    if (account.loading) return;
    // Không còn màn login: chưa có phiên thì tự đăng nhập thẳng (auto-login) đúng MỘT lần,
    // không điều hướng tới /auth/login. Backend luôn cấp phiên cho account hiện hành.
    // Lưu ý: auth.refresh() đi qua ServiceLinker trả về thenable (KHÔNG có .catch) →
    // bọc Promise.resolve để có Promise thật rồi nuốt lỗi qua .then(_, onError).
    if (!authenticated) {
      if (!autoLoginAttempted.current) {
        autoLoginAttempted.current = true;
        void Promise.resolve(auth.refresh()).then(undefined, () => {});
      }
      return;
    }
    autoLoginAttempted.current = false; // đã đăng nhập → cho phép auto-login lại nếu sau này mất phiên
    if (onLoginPage) navigate("/", { replace: true });
  }, [account.loading, authenticated, navigate, onLoginPage, auth]);

  return {
    ready: !account.loading,
    currentAccount,
    currentEmail,
    currentDisplayName,
    authenticated,
    login,
    logout,
    refresh,
    getJwtToken,
    beginPasskeyRegistration,
    finishPasskeyRegistration,
    beginPasskeyLogin,
    finishPasskeyLogin,
    effectiveSession
  };
});
