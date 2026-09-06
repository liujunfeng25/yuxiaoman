import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowClockwise,
  CalendarCheck,
  CaretLeft,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Copy,
  DeviceMobile,
  Key,
  LockKey,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SignOut,
  Storefront,
  UserCircle,
  Users,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { api, apiEnvelope, money, type AdminApiError } from "./adminApi";
import { operatorErrorMessage } from "./operatorError";

export type BackofficeRole = "platform_admin" | "wash_store_admin" | "inspection_station_admin" | "repair_shop_admin";

export type BackofficeSession = {
  account: { id: string; displayName: string; role: BackofficeRole };
  subject: { type: "wash_store" | "inspection_station" | "repair_shop"; id: string; name: string } | null;
  capabilities: string[];
  expiresAt: string;
};

type BackofficeGateProps = {
  children: (session: BackofficeSession, logout: () => Promise<void>) => ReactNode;
};

function replacePath(path: string) {
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function defaultPath(role: BackofficeRole) {
  if (role === "wash_store_admin") return "/wash/dashboard";
  if (role === "inspection_station_admin" || role === "repair_shop_admin") return "/my-audit";
  return "/bookings";
}

function BackofficeLoading({ error, retry }: { error?: string; retry?: () => void }) {
  return <main className="backoffice-auth-shell">
    <section className="backoffice-loading-card" aria-live="polite">
      <span className="backoffice-auth-mark"><ShieldCheck weight="duotone" /></span>
      {error ? <><h1>后台暂时无法连接</h1><p>{error}</p><button onClick={retry}><ArrowClockwise />重新连接</button></> : <><CircleNotch className="backoffice-spinner" /><h1>正在确认后台身份</h1><p>会话确认完成前不会读取任何业务数据。</p></>}
    </section>
  </main>;
}

function LoginPage({ onSignedIn }: { onSignedIn: (session: BackofficeSession) => void }) {
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const session = await api<BackofficeSession>("/backoffice/sessions", {
        method: "POST",
        body: JSON.stringify({ loginName: loginName.trim(), password }),
      });
      onSignedIn(session);
    } catch (reason) {
      const apiError = reason as AdminApiError;
      setError(apiError.status === 429 ? "登录尝试过于频繁，请稍后再试" : operatorErrorMessage(reason, "登录失败，请核对账号、密码后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="backoffice-auth-shell">
    <section className="backoffice-auth-card">
      <div className="backoffice-auth-intro">
        <div className="backoffice-auth-logo"><span><Storefront weight="fill" /></span><strong>驭小满</strong></div>
        <small>驭小满运营后台</small>
        <h1>一套后台，清晰管理每一个服务主体</h1>
        <p>平台团队掌握全局，合作门店只处理自己的订单、号源与资料。每一次关键操作均由系统留痕。</p>
        <div className="backoffice-auth-promise"><ShieldCheck weight="fill" /><span><strong>服务端数据隔离</strong><small>页面菜单和请求参数都不能扩大账号的数据范围</small></span></div>
      </div>
      <form className="backoffice-login-form" onSubmit={submit}>
        <header><span><LockKey weight="duotone" /></span><div><small>安全登录</small><h2>登录运营后台</h2></div></header>
        <label><span>登录名</span><div><UserCircle /><input autoFocus autoComplete="username" aria-label="后台登录名" value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="请输入平台分配的登录名" /></div></label>
        <label><span>密码</span><div><Key /><input autoComplete="current-password" aria-label="后台登录密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /></div></label>
        {error ? <p className="backoffice-form-error"><WarningCircle weight="fill" />{error}</p> : null}
        <button className="backoffice-primary" disabled={submitting || !loginName.trim() || !password}>{submitting ? <CircleNotch className="backoffice-spinner" /> : <ShieldCheck />}<span>{submitting ? "正在登录…" : "安全登录"}</span></button>
      </form>
    </section>
  </main>;
}

function ActivationPage({ token, onActivated }: { token: string; onActivated: (session: BackofficeSession) => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 12) return setError("密码至少需要 12 位字符");
    if (password !== confirmation) return setError("两次输入的密码不一致");
    setSubmitting(true);
    setError("");
    try {
      const session = await api<BackofficeSession>("/backoffice/activations", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      onActivated(session);
    } catch (reason) {
      setError(operatorErrorMessage(reason, "账号激活失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="backoffice-auth-shell"><section className="backoffice-activation-card">
    <span className="backoffice-auth-mark"><Key weight="duotone" /></span>
    <small>账号激活</small><h1>激活你的后台账号</h1>
    <p>设置一个仅用于驭小满运营后台的密码。激活成功后，此链接将立即失效并自动登录。</p>
    {!token ? <div className="backoffice-form-error"><XCircle weight="fill" />激活链接缺少令牌，请联系平台重新生成。</div> : <form onSubmit={submit}>
      <label><span>设置密码</span><input aria-label="设置后台密码" autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 位字符" /></label>
      <label><span>再次输入</span><input aria-label="确认后台密码" autoComplete="new-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入密码" /></label>
      {error ? <div className="backoffice-form-error"><WarningCircle weight="fill" />{error}</div> : null}
      <button className="backoffice-primary" disabled={submitting || !password || !confirmation}>{submitting ? <CircleNotch className="backoffice-spinner" /> : <CheckCircle />}完成激活并登录</button>
    </form>}
  </section></main>;
}

export function BackofficeGate({ children }: BackofficeGateProps) {
  const [session, setSession] = useState<BackofficeSession | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "anonymous" | "error">("loading");
  const [error, setError] = useState("");
  const activationToken = new URLSearchParams(window.location.search).get("token") || "";
  const activating = window.location.pathname === "/activate";

  const bootstrap = useCallback(async () => {
    if (activating) {
      setPhase("anonymous");
      return;
    }
    setPhase("loading");
    setError("");
    try {
      const next = await api<BackofficeSession>("/backoffice/session");
      setSession(next);
      setPhase("ready");
      if (["/", "/login"].includes(window.location.pathname)) replacePath(defaultPath(next.account.role));
    } catch (reason) {
      const apiError = reason as AdminApiError;
      if (apiError.status === 401) {
        setSession(null);
        setPhase("anonymous");
        if (window.location.pathname !== "/login") replacePath("/login");
      } else {
        setError(operatorErrorMessage(reason, "后台会话确认失败，请稍后重新连接"));
        setPhase("error");
      }
    }
  }, [activating]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    const unauthorized = () => {
      if (activating) return;
      setSession(null);
      setPhase("anonymous");
      if (window.location.pathname !== "/login") replacePath("/login");
    };
    window.addEventListener("yuxiaoman:backoffice-unauthorized", unauthorized);
    return () => window.removeEventListener("yuxiaoman:backoffice-unauthorized", unauthorized);
  }, [activating]);
  useEffect(() => {
    const updated = (event: Event) => {
      const next = (event as CustomEvent<BackofficeSession>).detail;
      if (!next?.account?.id || !next.expiresAt) return;
      setSession(next);
      setPhase("ready");
    };
    window.addEventListener("yuxiaoman:backoffice-session-updated", updated);
    return () => window.removeEventListener("yuxiaoman:backoffice-session-updated", updated);
  }, []);
  useEffect(() => {
    if (!session?.expiresAt) return;
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => {
      setSession(null);
      setPhase("anonymous");
      replacePath("/login");
    }, Math.min(remaining, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [session?.expiresAt]);

  const signedIn = (next: BackofficeSession) => {
    setSession(next);
    setPhase("ready");
    replacePath(defaultPath(next.account.role));
  };
  const logout = async () => {
    try { await api("/backoffice/session", { method: "DELETE" }); } catch { /* local session is cleared either way */ }
    setSession(null);
    setPhase("anonymous");
    replacePath("/login");
  };

  if (activating) return <ActivationPage token={activationToken} onActivated={signedIn} />;
  if (phase === "loading") return <BackofficeLoading />;
  if (phase === "error") return <BackofficeLoading error={error} retry={() => void bootstrap()} />;
  if (!session || phase === "anonymous") return <LoginPage onSignedIn={signedIn} />;
  return <>{children(session, logout)}</>;
}

export function BackofficeAccountBadge({ session, logout }: { session: BackofficeSession; logout: () => Promise<void> }) {
  const [changingPassword, setChangingPassword] = useState(false);
  return <><div className="backoffice-account-badge">
    <span><UserCircle weight="duotone" /></span>
    <div><strong>{session.account.displayName}</strong><small>{session.account.role === "platform_admin" ? "平台管理员" : session.account.role === "inspection_station_admin" ? "检测站管理员" : session.account.role === "repair_shop_admin" ? "维修门店管理员" : "洗车店管理员"}</small></div>
    <button aria-label="修改后台密码" title="修改密码" onClick={() => setChangingPassword(true)}><Key /></button>
    <button aria-label="退出后台" title="退出登录" onClick={() => void logout()}><SignOut /></button>
  </div>{changingPassword ? <ChangePasswordDialog close={() => setChangingPassword(false)} /> : null}</>;
}

function ChangePasswordDialog({ close }: { close: () => void }) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmation: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.newPassword.length < 12) return setError("新密码至少需要 12 位字符");
    if (form.newPassword !== form.confirmation) return setError("两次输入的新密码不一致");
    setSaving(true); setError("");
    try {
      const next = await api<BackofficeSession>("/backoffice/password", { method: "PUT", body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) });
      window.dispatchEvent(new CustomEvent("yuxiaoman:backoffice-session-updated", { detail: next }));
      close();
    } catch (reason) { setError(operatorErrorMessage(reason, "密码修改失败，请稍后重试")); }
    finally { setSaving(false); }
  };
  return <div className="backoffice-password-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className="backoffice-password-dialog" onSubmit={submit}><header><span><Key weight="duotone" /></span><div><small>密码设置</small><h2>修改后台密码</h2></div><button type="button" aria-label="关闭修改密码" onClick={close}><XCircle /></button></header><p>修改成功后，系统会撤销此账号在其他设备上的会话。</p><label><span>当前密码</span><input aria-label="当前后台密码" autoComplete="current-password" type="password" required value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} /></label><label><span>新密码</span><input aria-label="新的后台密码" autoComplete="new-password" type="password" required value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} placeholder="至少 12 位字符" /></label><label><span>确认新密码</span><input aria-label="确认新的后台密码" autoComplete="new-password" type="password" required value={form.confirmation} onChange={(event) => setForm({ ...form, confirmation: event.target.value })} /></label>{error ? <div className="backoffice-form-error"><WarningCircle weight="fill" />{error}</div> : null}<button className="backoffice-primary" disabled={saving}><Key />{saving ? "正在修改…" : "确认修改密码"}</button></form></div>;
}

export function BackofficeSubjectCard({ session }: { session: BackofficeSession }) {
  const [status, setStatus] = useState<"loading" | "active" | "inactive" | "error">("loading");
  useEffect(() => {
    if (!session.subject) return;
    if (session.subject.type === "inspection_station" || session.subject.type === "repair_shop") {
      setStatus("active");
      return;
    }
    let cancelled = false;
    void api<ListPayload<{ id: string; isActive?: boolean; isOpen?: boolean }>>("/admin/wash/stores")
      .then((payload) => {
        if (cancelled) return;
        const store = listOf(payload).find((item) => item.id === session.subject?.id);
        setStatus(store ? (store.isActive && store.isOpen !== false ? "active" : "inactive") : "error");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [session.subject?.id]);
  if (!session.subject) return null;
  const station = session.subject.type === "inspection_station";
  const repairShop = session.subject.type === "repair_shop";
  return <section className="backoffice-subject-card">
    <header><Storefront weight="duotone" /><span>当前经营主体</span></header>
    <small>{station ? "检测站" : repairShop ? "维修门店" : "洗车门店"}</small><strong>{session.subject.name}</strong>
    <span className={`backoffice-subject-status ${status}`}><i />{station ? "已绑定单站范围" : repairShop ? "已绑定单店范围" : status === "loading" ? "状态读取中" : status === "active" ? "经营中" : status === "inactive" ? "暂停营业" : "状态暂不可用"}</span>
  </section>;
}

export function AccessDeniedPage({ home }: { home: () => void }) {
  return <section className="backoffice-state-page">
    <span><ShieldCheck weight="duotone" /></span><small>403 · 无权访问</small>
    <h2>这个账号没有访问权限</h2><p>当前页面不属于你被授权的业务模块。数据范围由登录账号绑定的经营主体决定。</p>
    <button onClick={home}><CaretLeft />返回我的工作台</button>
  </section>;
}

type StoreOption = { id: string; name: string; district?: string; isActive?: boolean };
type StationOption = { id: string; name: string; district?: string; isActive?: boolean };
type RepairShopOption = { id: string; name: string; district?: string; isActive?: boolean; isDemo?: boolean };
type AccountSubject = { type: "wash_store" | "inspection_station" | "repair_shop"; id: string; name?: string };
type AccountRecord = {
  id: string;
  loginName: string;
  displayName: string;
  role: BackofficeRole;
  status: "pending_activation" | "active" | "disabled" | string;
  subject?: AccountSubject | null;
  subjectAssignment?: AccountSubject | null;
  createdAt?: string;
  activatedAt?: string | null;
  lastLoginAt?: string | null;
};
type ActivationResult = { url?: string; token?: string; expiresAt: string };
type AccountMutationResult = { account: AccountRecord; activation?: ActivationResult };
type ListPayload<T> = T[] | { items: T[]; total?: number; page?: number; pageSize?: number };

function listOf<T>(payload: ListPayload<T>): T[] { return Array.isArray(payload) ? payload : payload.items; }
function accountSubject(account: AccountRecord) { return account.subject ?? account.subjectAssignment ?? null; }
function localDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待核对" : date.toLocaleString("zh-CN", { hour12: false });
}
function serviceAccountRoleMeta(role: BackofficeRole) {
  if (role === "inspection_station_admin") return {
    roleLabel: "检测站管理员",
    surfaceLabel: "微信小程序 · 检测站履约端",
    surfaceHint: "我的 → 工作人员入口",
    fullHint: "使用微信小程序「我的 → 工作人员入口 → 检测站履约端」登录，仅处理绑定检测站；登录网页后台时仅可查看本人操作记录。",
  };
  if (role === "repair_shop_admin") return {
    roleLabel: "维修门店管理员",
    surfaceLabel: "微信小程序 · 维修门店端",
    surfaceHint: "我的 → 工作人员入口 → 维修门店端",
    fullHint: "使用微信小程序「我的 → 工作人员入口 → 维修门店端」登录，仅处理绑定维修门店的需求与报价；登录网页后台时仅可查看本人操作记录。",
  };
  return {
    roleLabel: "洗车店管理员",
    surfaceLabel: "电脑端 · 服务商经营后台",
    surfaceHint: "当前后台登录页",
    fullHint: "使用当前网页后台登录，仅可查看和管理绑定洗车门店的订单、号源、价格、资料与对账。",
  };
}

function ActivationNotice({ activation, close }: { activation: ActivationResult; close: () => void }) {
  const activationLink = activation.url || `${window.location.origin}/activate?token=${encodeURIComponent(activation.token || "")}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(activationLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <div className="backoffice-activation-notice" role="status">
    <div><Key weight="duotone" /><span><small>一次性激活链接 · 仅本次展示</small><strong>{activationLink}</strong><em>有效期至 {localDate(activation.expiresAt)}</em></span></div>
    <button onClick={() => void copy()}>{copied ? <CheckCircle weight="fill" /> : <Copy />}{copied ? "已复制" : "复制链接"}</button>
    <button className="icon-only" aria-label="关闭激活链接" onClick={close}><XCircle /></button>
  </div>;
}

export function ServiceAccountsPage({ onError }: { onError: (message: string) => void }) {
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [stations, setStations] = useState<StationOption[]>([]);
  const [repairShops, setRepairShops] = useState<RepairShopOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [directPasswordEnabled, setDirectPasswordEnabled] = useState(false);
  const [activation, setActivation] = useState<ActivationResult | null>(null);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState<{
    loginName: string;
    displayName: string;
    password: string;
    role: "wash_store_admin" | "inspection_station_admin" | "repair_shop_admin";
    subjectId: string;
  }>({ loginName: "", displayName: "", password: "", role: "wash_store_admin", subjectId: "" });
  const [replacement, setReplacement] = useState<AccountRecord | null>(null);
  const [replacementForm, setReplacementForm] = useState({ loginName: "", displayName: "", password: "" });
  const [passwordResetTarget, setPasswordResetTarget] = useState<AccountRecord | null>(null);
  const [passwordResetValue, setPasswordResetValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accountPayload, storePayload, stationPayload, repairShopPayload] = await Promise.all([
        apiEnvelope<ListPayload<AccountRecord>>("/admin/backoffice/accounts"),
        api<ListPayload<StoreOption>>("/admin/wash/stores"),
        api<ListPayload<StationOption>>("/admin/stations"),
        api<ListPayload<RepairShopOption>>("/admin/repair/shops"),
      ]);
      setDirectPasswordEnabled(Boolean(accountPayload.meta?.directPasswordEnabled));
      setAccounts(listOf(accountPayload.data));
      setStores(listOf(storePayload));
      setStations(listOf(stationPayload));
      setRepairShops(listOf(repairShopPayload));
    } catch (reason) { onError(operatorErrorMessage(reason, "服务商账号资料读取失败，请稍后重试")); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setInviting(true);
    try {
      const result = await api<AccountMutationResult>("/admin/backoffice/accounts/invitations", {
        method: "POST",
        body: JSON.stringify({
          loginName: form.loginName.trim(),
          displayName: form.displayName.trim(),
          role: form.role,
          subject: {
            type: form.role === "inspection_station_admin" ? "inspection_station" : form.role === "repair_shop_admin" ? "repair_shop" : "wash_store",
            id: form.subjectId,
          },
          ...(directPasswordEnabled && form.password.trim() ? { password: form.password.trim() } : {}),
        }),
      });
      if (result.activation) setActivation(result.activation);
      setForm({ loginName: "", displayName: "", password: "", role: form.role, subjectId: "" });
      await load();
    } catch (reason) { onError(operatorErrorMessage(reason, "账号邀请创建失败，请稍后重试")); }
    finally { setInviting(false); }
  };

  const resetPassword = async (account: AccountRecord) => {
    if (directPasswordEnabled) {
      setPasswordResetTarget(account);
      setPasswordResetValue("");
      return;
    }
    try {
      const result = await api<AccountMutationResult>(`/admin/backoffice/accounts/${account.id}/password-reset`, { method: "POST" });
      if (result.activation) setActivation(result.activation);
      await load();
    } catch (reason) { onError(operatorErrorMessage(reason, "密码重置失败，请稍后重试")); }
  };
  const submitDirectPasswordReset = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwordResetTarget) return;
    setInviting(true);
    try {
      await api<AccountMutationResult>(`/admin/backoffice/accounts/${passwordResetTarget.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: passwordResetValue.trim() }),
      });
      setPasswordResetTarget(null);
      setPasswordResetValue("");
      await load();
    } catch (reason) { onError(operatorErrorMessage(reason, "密码重置失败，请稍后重试")); }
    finally { setInviting(false); }
  };
  const disable = async (account: AccountRecord) => {
    if (!window.confirm(`确认停用“${account.displayName}”？该账号的现有会话将立即失效。`)) return;
    try {
      await api(`/admin/backoffice/accounts/${account.id}/disable`, { method: "POST" });
      await load();
    } catch (reason) { onError(operatorErrorMessage(reason, "账号停用失败，请稍后重试")); }
  };
  const replace = async (event: FormEvent) => {
    event.preventDefault();
    if (!replacement) return;
    setInviting(true);
    try {
      const result = await api<AccountMutationResult>(`/admin/backoffice/accounts/${replacement.id}/replacements`, {
        method: "POST",
        body: JSON.stringify({
          loginName: replacementForm.loginName.trim(),
          displayName: replacementForm.displayName.trim(),
          ...(directPasswordEnabled && replacementForm.password.trim()
            ? { password: replacementForm.password.trim() }
            : {}),
        }),
      });
      if (result.activation) setActivation(result.activation);
      setReplacement(null);
      await load();
    } catch (reason) { onError(operatorErrorMessage(reason, "账号交接失败，请稍后重试")); }
    finally { setInviting(false); }
  };

  const availableStores = useMemo(() => stores.filter((store) => !accounts.some((account) => account.status !== "disabled" && accountSubject(account)?.type === "wash_store" && accountSubject(account)?.id === store.id)), [accounts, stores]);
  const availableStations = useMemo(() => stations.filter((station) => !accounts.some((account) => account.status !== "disabled" && accountSubject(account)?.type === "inspection_station" && accountSubject(account)?.id === station.id)), [accounts, stations]);
  const availableRepairShops = useMemo(() => repairShops.filter((shop) => !accounts.some((account) => account.status !== "disabled" && accountSubject(account)?.type === "repair_shop" && accountSubject(account)?.id === shop.id)), [accounts, repairShops]);
  const serviceAccounts = accounts.filter((account) => account.role === "wash_store_admin" || account.role === "inspection_station_admin" || account.role === "repair_shop_admin");
  const subjectOptions = form.role === "inspection_station_admin" ? availableStations : form.role === "repair_shop_admin" ? availableRepairShops : availableStores;
  const subjectLabel = form.role === "inspection_station_admin" ? "绑定检测站" : form.role === "repair_shop_admin" ? "绑定维修门店" : "绑定洗车门店";
  const subjectTypeLabel = (type: AccountSubject["type"] | undefined, role: BackofficeRole) => {
    if (type === "inspection_station" || (!type && role === "inspection_station_admin")) return "检测站";
    if (type === "repair_shop" || (!type && role === "repair_shop_admin")) return "维修门店";
    return "洗车门店";
  };
  const subjectFallback = (subject?: AccountSubject | null) => {
    if (!subject) return undefined;
    const options = subject.type === "inspection_station" ? stations : subject.type === "repair_shop" ? repairShops : stores;
    return options.find((item) => item.id === subject.id)?.name;
  };

  return <div className="backoffice-management-layout">
    {activation ? <ActivationNotice activation={activation} close={() => setActivation(null)} /> : null}
    <section className="content-card backoffice-invite-card">
      <header><div><small>新增服务商账号</small><h2>{directPasswordEnabled ? "创建服务主体管理员" : "邀请服务主体管理员"}</h2><p>{directPasswordEnabled ? "当前为本地演示模式：填写登录名和至少 12 位密码后，账号立即启用。" : "每个服务主体只能有一名有效管理员。创建后由对方通过一次性链接设置密码。"}</p></div><span><Users weight="duotone" /></span></header>
      <div className="backoffice-login-entry-guide" aria-label="账号类型与登录入口说明">
        <article><span><Storefront weight="duotone" /></span><div><strong>洗车店管理员</strong><em>电脑端服务商经营后台</em><small>登录当前网页后台，仅管理绑定洗车门店。</small></div></article>
        <article><span><DeviceMobile weight="duotone" /></span><div><strong>检测站管理员</strong><em>微信小程序检测站履约端</em><small>路径：我的 → 工作人员入口；网页后台仅查看本人操作记录。</small></div></article>
        <article><span><DeviceMobile weight="duotone" /></span><div><strong>维修门店管理员</strong><em>微信小程序维修门店端</em><small>路径：我的 → 工作人员入口 → 维修门店端；网页后台仅查看本人操作记录。</small></div></article>
      </div>
      <form onSubmit={invite}>
        <label><span>实名姓名</span><input aria-label="服务商管理员姓名" required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：王志强" /></label>
        <label><span>登录名</span><input aria-label="服务商账号登录名" required value={form.loginName} onChange={(event) => setForm({ ...form, loginName: event.target.value })} placeholder="建议使用服务主体简称拼音" /></label>
        {directPasswordEnabled ? <label><span>登录密码</span><input aria-label="服务商账号登录密码" required minLength={12} type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="至少 12 位" /></label> : null}
        <label><span>账号类型</span><select aria-label="服务商账号类型" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as typeof form.role, subjectId: "" })}><option value="wash_store_admin">洗车店管理员 · 网页后台</option><option value="inspection_station_admin">检测站管理员 · 小程序检测端</option><option value="repair_shop_admin">维修门店管理员 · 小程序维修端</option></select></label>
        <div className="backoffice-login-surface-reminder"><ShieldCheck weight="duotone" /><p>{serviceAccountRoleMeta(form.role).fullHint}</p></div>
        <label><span>{subjectLabel}</span><select aria-label="服务商绑定主体" required value={form.subjectId} onChange={(event) => setForm({ ...form, subjectId: event.target.value })}><option value="">请选择尚未绑定的服务主体</option>{subjectOptions.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}{"isDemo" in subject && subject.isDemo ? " · 演示主体" : subject.district ? ` · ${subject.district}` : ""}</option>)}</select></label>
        <button className="backoffice-primary" disabled={inviting || !form.subjectId || (directPasswordEnabled && form.password.trim().length < 12)}><Plus />{inviting ? "正在创建…" : directPasswordEnabled ? "创建并启用账号" : "创建账号并生成激活链接"}</button>
      </form>
    </section>
    <section className="content-card backoffice-account-list">
      <header><div><small>{serviceAccounts.length} 个服务商账号</small><h2>服务商账号</h2></div><button onClick={() => void load()}><ArrowClockwise />刷新</button></header>
      <div className="table-wrap"><table><thead><tr><th>人员与登录名</th><th>账号类型与登录端</th><th>绑定主体</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>{serviceAccounts.map((account) => { const subject = accountSubject(account); const roleMeta = serviceAccountRoleMeta(account.role); return <tr key={account.id}>
        <td><strong>{account.displayName}</strong><small>{account.loginName}</small></td>
        <td><strong>{roleMeta.roleLabel}</strong><small>{roleMeta.surfaceLabel}</small><em className="backoffice-account-entry-path">{roleMeta.surfaceHint}</em></td>
        <td><strong>{subject?.name || subjectFallback(subject) || "未绑定"}</strong><small>{subjectTypeLabel(subject?.type, account.role)}</small></td>
        <td><span className={`backoffice-account-status ${account.status}`}>{account.status === "active" ? "已启用" : ["pending_activation", "invited"].includes(account.status) ? "待激活" : account.status === "disabled" ? "已停用" : "状态待核对"}</span><small>{account.activatedAt ? `激活于 ${localDate(account.activatedAt)}` : "尚未完成首次激活"}</small></td>
        <td><strong>{localDate(account.lastLoginAt)}</strong></td>
        <td><div className="backoffice-row-actions">{account.status !== "disabled" ? <><button onClick={() => void resetPassword(account)}><Key />{directPasswordEnabled ? "设置密码" : "重置密码"}</button><button onClick={() => { setReplacement(account); setReplacementForm({ loginName: "", displayName: "", password: "" }); }}><Users />更换管理员</button><button className="danger" onClick={() => void disable(account)}>停用</button></> : null}</div></td>
      </tr>; })}</tbody></table>{loading ? <div className="table-loading">正在读取账号…</div> : !serviceAccounts.length ? <div className="empty-table">还没有服务商账号</div> : null}</div>
    </section>
    {replacement ? <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && setReplacement(null)}><aside className="detail-drawer backoffice-replacement-drawer"><header><div><small>更换管理员</small><h2>{replacement.role === "inspection_station_admin" ? "更换检测站管理员" : replacement.role === "repair_shop_admin" ? "更换维修门店管理员" : "更换洗车店管理员"}</h2><p>{accountSubject(replacement)?.name || replacement.displayName}</p></div><button aria-label="关闭更换管理员" onClick={() => setReplacement(null)}><XCircle /></button></header><form onSubmit={replace}>
      <div className="backoffice-replacement-note"><WarningCircle weight="fill" /><p>{directPasswordEnabled ? `填写新管理员信息并直接设置密码后，旧账号会立即失效；新管理员使用${serviceAccountRoleMeta(replacement.role).surfaceLabel}登录。` : `旧管理员会保持可用，直到新管理员完成激活。激活后旧账号与旧会话立即失效，新管理员使用${serviceAccountRoleMeta(replacement.role).surfaceLabel}登录。`}</p></div>
      <label><span>新管理员实名姓名</span><input aria-label="新管理员姓名" required value={replacementForm.displayName} onChange={(event) => setReplacementForm({ ...replacementForm, displayName: event.target.value })} /></label>
      <label><span>新登录名</span><input aria-label="新管理员登录名" required value={replacementForm.loginName} onChange={(event) => setReplacementForm({ ...replacementForm, loginName: event.target.value })} /></label>
      {directPasswordEnabled ? <label><span>新登录密码</span><input aria-label="新管理员登录密码" required minLength={12} type="password" autoComplete="new-password" value={replacementForm.password} onChange={(event) => setReplacementForm({ ...replacementForm, password: event.target.value })} placeholder="至少 12 位" /></label> : null}
      <button className="backoffice-primary" disabled={inviting || (directPasswordEnabled && replacementForm.password.trim().length < 12)}><Users />{directPasswordEnabled ? "更换并启用新管理员" : "生成替换激活链接"}</button>
    </form></aside></div> : null}
    {passwordResetTarget ? <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && setPasswordResetTarget(null)}><aside className="detail-drawer backoffice-replacement-drawer"><header><div><small>设置密码</small><h2>直接设置密码</h2><p>{passwordResetTarget.displayName} · {passwordResetTarget.loginName}</p></div><button aria-label="关闭设置密码" onClick={() => setPasswordResetTarget(null)}><XCircle /></button></header><form onSubmit={submitDirectPasswordReset}>
      <div className="backoffice-login-surface-reminder"><ShieldCheck weight="duotone" /><p>保存后旧会话立即失效，请使用新密码重新登录{serviceAccountRoleMeta(passwordResetTarget.role).surfaceLabel}。</p></div>
      <label><span>新登录密码</span><input aria-label="新登录密码" required minLength={12} type="password" autoComplete="new-password" value={passwordResetValue} onChange={(event) => setPasswordResetValue(event.target.value)} placeholder="至少 12 位" /></label>
      <button className="backoffice-primary" disabled={inviting || passwordResetValue.trim().length < 12}><Key />保存密码并启用账号</button>
    </form></aside></div> : null}
  </div>;
}

type AuditEvent = {
  id: string;
  category: { code: string; label: string };
  actionLabel: string;
  summary: string;
  actor: { id: string | null; displayName: string; roleLabel: string };
  subject: { type: string; id: string; name: string } | null;
  target: { type: string; id: string | null; label: string | null } | null;
  outcome: { code: "success" | "denied" | "failure"; label: string };
  occurredAt: string;
  hasDetails: boolean;
};

type AuditEventDetail = AuditEvent & {
  changes: Array<{ field: string; label: string; before: string | null; after: string | null }>;
  reason: string | null;
};

const auditCategories = [
  ["account_security", "账号与安全"],
  ["inspection", "预约与检测"],
  ["wash", "洗车服务"],
  ["repair", "维修服务"],
  ["car_rental", "汽车租赁"],
  ["insurance", "车险服务"],
  ["driving_school", "驾校服务"],
  ["subsidy", "补贴咨询"],
] as const;

function auditTime(event: AuditEvent) { return event.occurredAt; }

function AuditDetailDrawer({ event, loading, error, close, retry }: {
  event: AuditEventDetail | AuditEvent;
  loading: boolean;
  error: string;
  close: () => void;
  retry: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeHandlerRef = useRef(close);
  closeHandlerRef.current = close;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (keyEvent.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? []).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);
  const detail = "changes" in event ? event : null;
  return <div className="drawer-layer backoffice-audit-drawer-layer" role="presentation" onMouseDown={(mouseEvent) => mouseEvent.target === mouseEvent.currentTarget && close()}>
    <aside ref={drawerRef} className="detail-drawer backoffice-audit-drawer" role="dialog" aria-modal="true" aria-label="操作记录详情">
      <header><div><small>{event.category.label}</small><h2>{event.actionLabel}</h2><p>{event.outcome.label}</p></div><button ref={closeRef} aria-label="关闭操作记录详情" onClick={close}><XCircle /></button></header>
      <div className="drawer-scroll">
        <section className="drawer-status backoffice-audit-summary"><span className={`backoffice-audit-outcome ${event.outcome.code}`}>{event.outcome.label}</span><strong>{event.summary}</strong><small>{localDate(event.occurredAt)}</small></section>
        {loading ? <div className="backoffice-audit-detail-state"><CircleNotch className="backoffice-spinner" /><strong>正在读取记录详情</strong></div> : null}
        {error ? <div className="backoffice-audit-detail-state error"><WarningCircle /><strong>操作记录加载失败</strong><small>{error}</small><button onClick={retry}><ArrowClockwise />重新加载</button></div> : null}
        {!loading && !error ? <>
          <section className="detail-section backoffice-audit-info"><h3>操作信息</h3><dl><div><dt>操作人员</dt><dd>{event.actor.displayName}</dd></div><div><dt>账号角色</dt><dd>{event.actor.roleLabel}</dd></div><div><dt>所属主体</dt><dd>{event.subject?.name || "平台账号与安全"}</dd></div><div><dt>影响对象</dt><dd>{event.target?.label || "—"}</dd></div></dl></section>
          {detail?.changes.length ? <section className="detail-section backoffice-audit-changes"><h3>变更内容</h3>{detail.changes.map((change) => <div key={`${change.field}-${change.label}`}><span>{change.label}</span><strong>{change.before ?? "—"}</strong><CaretRight /><strong>{change.after ?? "—"}</strong></div>)}</section> : <section className="detail-section backoffice-audit-no-change"><CheckCircle /><span><strong>操作已记录</strong><small>该操作没有需要额外展示的字段变化。</small></span></section>}
          {detail?.reason ? <section className="detail-section backoffice-audit-reason"><WarningCircle /><span><strong>未执行原因</strong><small>{detail.reason}</small></span></section> : null}
        </> : null}
      </div>
    </aside>
  </div>;
}

export function AuditEventsPage({ selfOnly = false, selfRole, onError: _onError }: { selfOnly?: boolean; selfRole?: BackofficeRole; onError: (message: string) => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [subjects, setSubjects] = useState<StoreOption[]>([]);
  const [filters, setFilters] = useState({ keyword: "", category: "", outcome: "", accountId: "", subjectId: "", dateFrom: "", dateTo: "" });
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [detail, setDetail] = useState<AuditEventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const pageSize = 25;
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filters.keyword.trim()) query.set("keyword", filters.keyword.trim());
    if (filters.category) query.set("category", filters.category);
    if (filters.outcome) query.set("outcome", filters.outcome);
    if (filters.accountId) query.set("accountId", filters.accountId);
    if (filters.subjectId) query.set("subjectId", filters.subjectId);
    if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) query.set("dateTo", filters.dateTo);
    try {
      const response = await apiEnvelope<ListPayload<AuditEvent>, { page: number; pageSize: number; total: number }>(`/admin/audit-events?${query}`);
      const payload = response.data;
      const items = listOf(payload);
      setEvents(items);
      setTotal(response.meta?.total ?? (Array.isArray(payload) ? items.length : payload.total ?? items.length));
    } catch (reason) { setLoadError(operatorErrorMessage(reason, "操作记录加载失败，请稍后重试")); }
    finally { setLoading(false); }
  }, [filters.accountId, filters.category, filters.dateFrom, filters.dateTo, filters.keyword, filters.outcome, filters.subjectId, page]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 180); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (selfOnly) return;
    void Promise.allSettled([
      api<ListPayload<AccountRecord>>("/admin/backoffice/accounts"),
      api<ListPayload<StoreOption>>("/admin/wash/stores"),
      api<ListPayload<StationOption>>("/admin/stations"),
      api<ListPayload<RepairShopOption>>("/admin/repair/shops"),
    ]).then(([accountResult, storeResult, stationResult, repairResult]) => {
      if (accountResult.status === "fulfilled") setAccounts(listOf(accountResult.value));
      const nextSubjects: StoreOption[] = [];
      if (storeResult.status === "fulfilled") nextSubjects.push(...listOf(storeResult.value));
      if (stationResult.status === "fulfilled") nextSubjects.push(...listOf(stationResult.value));
      if (repairResult.status === "fulfilled") nextSubjects.push(...listOf(repairResult.value));
      setSubjects(nextSubjects);
    });
  }, [selfOnly]);
  const loadDetail = useCallback(async (event: AuditEvent) => {
    setSelected(event);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try { setDetail(await api<AuditEventDetail>(`/admin/audit-events/${encodeURIComponent(event.id)}`)); }
    catch (reason) { setDetailError(operatorErrorMessage(reason, "操作详情读取失败，请稍后重试")); }
    finally { setDetailLoading(false); }
  }, []);
  const clearFilters = () => { setPage(1); setFilters({ keyword: "", category: "", outcome: "", accountId: "", subjectId: "", dateFrom: "", dateTo: "" }); };
  const selfBusinessCategory = selfRole === "inspection_station_admin" ? "inspection" : selfRole === "repair_shop_admin" ? "repair" : "wash";
  const availableCategories = selfOnly ? auditCategories.filter(([code]) => code === selfBusinessCategory || code === "account_security") : auditCategories;

  return <>
    <section className="content-card backoffice-audit-card">
      <header><div><small>{selfOnly ? "当前账号 · 当前门店" : "全平台关键操作"}</small><h2>{selfOnly ? "我的操作记录" : "操作记录"}</h2><p>{selfOnly ? "仅显示你在当前门店完成的关键操作。" : "记录账号、安全及影响业务结果的关键操作；查看、搜索和翻页不会产生记录。"}</p></div><span><ShieldCheck weight="duotone" /></span></header>
      <div className="filters backoffice-audit-filters"><span><MagnifyingGlass />筛选</span><input aria-label="操作记录关键词" value={filters.keyword} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, keyword: changeEvent.target.value }); }} placeholder="人员、门店、订单号或账号名" /><select aria-label="操作记录业务分类" value={filters.category} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, category: changeEvent.target.value }); }}><option value="">全部业务</option>{availableCategories.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select>{!selfOnly ? <><select aria-label="操作记录操作人员" value={filters.accountId} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, accountId: changeEvent.target.value }); }}><option value="">全部操作人员</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.displayName}</option>)}</select><select aria-label="操作记录业务主体" value={filters.subjectId} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, subjectId: changeEvent.target.value }); }}><option value="">全部业务主体</option>{subjects.map((subject) => <option value={subject.id} key={subject.id}>{subject.name}</option>)}</select></> : null}<select aria-label="操作记录结果" value={filters.outcome} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, outcome: changeEvent.target.value }); }}><option value="">全部结果</option><option value="success">成功</option><option value="denied">已拒绝</option><option value="failure">失败</option></select><label><span>开始日期</span><input aria-label="操作记录开始日期" type="date" value={filters.dateFrom} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, dateFrom: changeEvent.target.value }); }} /></label><label><span>结束日期</span><input aria-label="操作记录结束日期" type="date" value={filters.dateTo} onChange={(changeEvent) => { setPage(1); setFilters({ ...filters, dateTo: changeEvent.target.value }); }} /></label><button onClick={clearFilters}>清空</button></div>
      {loadError ? <div className="backoffice-audit-load-error"><WarningCircle /><span><strong>操作记录加载失败</strong><small>{loadError}</small></span><button onClick={() => void load()}><ArrowClockwise />重新加载</button></div> : null}
      <div className={`table-wrap backoffice-audit-table${selfOnly ? " self-only" : ""}`}><table><thead><tr><th>时间</th>{!selfOnly ? <th>操作人员</th> : null}<th>操作内容</th><th>影响对象</th><th>结果</th><th>详情</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}>
        <td><strong>{localDate(auditTime(event))}</strong></td>{!selfOnly ? <td><strong>{event.actor.displayName}</strong><small>{event.actor.roleLabel}</small></td> : null}
        <td className="backoffice-audit-content"><strong>{event.actionLabel}</strong><small>{event.summary}</small></td><td><strong>{event.target?.label || event.subject?.name || "平台账号与安全"}</strong><small>{event.category.label}</small></td><td><span className={`backoffice-audit-outcome ${event.outcome.code}`}>{event.outcome.label}</span></td><td><button className="backoffice-audit-detail-button" onClick={() => void loadDetail(event)}>查看详情<CaretRight /></button></td>
      </tr>)}</tbody></table>{loading ? <div className="table-loading">正在读取操作记录…</div> : !events.length && !loadError ? <div className="empty-table backoffice-audit-empty"><ShieldCheck /><strong>{filters.keyword || filters.category || filters.outcome || filters.accountId || filters.subjectId || filters.dateFrom || filters.dateTo ? "没有符合当前条件的操作记录" : "暂无关键操作记录"}</strong><small>{filters.keyword || filters.category || filters.outcome || filters.accountId || filters.subjectId || filters.dateFrom || filters.dateTo ? "可以调整条件或清除筛选后重试。" : "完成业务变更、账号操作或核销后，会在这里显示。"}</small>{filters.keyword || filters.category || filters.outcome || filters.accountId || filters.subjectId || filters.dateFrom || filters.dateTo ? <button onClick={clearFilters}>清除筛选</button> : null}</div> : null}</div>
      <footer className="backoffice-pagination"><span>共 <strong>{total}</strong> 条不可修改记录</span><div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><CaretLeft />上一页</button><span>第 {page} 页</span><button disabled={page * pageSize >= total} onClick={() => setPage((value) => value + 1)}>下一页<CaretRight /></button></div></footer>
    </section>
    {selected ? <AuditDetailDrawer event={detail ?? selected} loading={detailLoading} error={detailError} close={() => { setSelected(null); setDetail(null); setDetailError(""); }} retry={() => void loadDetail(selected)} /> : null}
  </>;
}

type DashboardOrder = { id: string; orderNumber: string; appointmentDate: string; startTime: string; vehiclePlate: string; packageName?: string; status: string };
const dashboardOrderStatusLabels: Record<string, string> = {
  pending_payment: "待支付",
  awaiting_redemption: "待人工核销",
  paid: "已支付",
  booked: "待到店",
  redeemed: "已核销",
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
  expired: "已过期",
};
type DashboardPayload = {
  metrics?: Record<string, number>;
  todayOrders?: number;
  awaitingRedemption?: number;
  futureSlots?: number;
  futureCapacity?: number;
  serviceAmountLast7DaysFen?: number;
  sevenDayServiceAmountFen?: number;
  recentEvents?: AuditEvent[];
  recentAuditEvents?: AuditEvent[];
  recentOrders?: DashboardOrder[];
};

export function WashProviderDashboard({ onNavigate, onError }: { onNavigate: (path: string) => void; onError: (message: string) => void }) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<DashboardPayload>("/admin/wash/dashboard"));
    }
    catch (reason) { onError(operatorErrorMessage(reason, "门店经营数据读取失败，请稍后重试")); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const metrics = data?.metrics ?? {};
  const todayOrders = data?.todayOrders ?? metrics.todayOrders ?? 0;
  const awaiting = data?.awaitingRedemption ?? metrics.awaitingRedemption ?? 0;
  const futureSlots = data?.futureSlots ?? data?.futureCapacity ?? metrics.futureSlots ?? metrics.futureCapacity ?? metrics.availableFutureSlots ?? 0;
  const amount = data?.serviceAmountLast7DaysFen ?? data?.sevenDayServiceAmountFen ?? metrics.serviceAmountLast7DaysFen ?? metrics.sevenDayServiceAmountFen ?? 0;
  const events = data?.recentEvents ?? data?.recentAuditEvents ?? [];
  return <div className="wash-provider-dashboard">
    <section className="provider-welcome-card"><div><small>门店运营</small><h2>今天的门店经营，从这里开始</h2><p>订单、号源和价格均已固定在当前登录门店范围内。</p></div><button onClick={() => onNavigate("/wash/orders")}><CalendarCheck />查看今日订单<CaretRight /></button></section>
    <section className="metric-strip provider-metric-strip">
      <button onClick={() => onNavigate("/wash/orders")}><span><CalendarCheck /></span><small>今日订单</small><strong>{todayOrders}<em> 笔</em></strong></button>
      <button onClick={() => onNavigate("/wash/orders")}><span><Key /></span><small>待核销</small><strong>{awaiting}<em> 笔</em></strong></button>
      <button onClick={() => onNavigate("/wash/slots")}><span><Storefront /></span><small>未来可用号源</small><strong>{futureSlots}<em> 个</em></strong></button>
      <button onClick={() => onNavigate("/wash/settlements")}><span><ShieldCheck /></span><small>近 7 日服务金额</small><strong>¥{money(amount)}</strong></button>
    </section>
    <div className="provider-dashboard-grid"><section className="content-card provider-recent-orders"><header><div><small>近期服务</small><h2>最近服务订单</h2></div><button onClick={() => onNavigate("/wash/orders")}>全部订单<CaretRight /></button></header>{data?.recentOrders?.length ? <div>{data.recentOrders.map((order) => <button key={order.id} onClick={() => onNavigate(`/wash/orders?order=${encodeURIComponent(order.id)}`)}><span><strong>{order.appointmentDate} {order.startTime}</strong><small>{order.orderNumber}</small></span><span><strong>{order.vehiclePlate}</strong><small>{order.packageName || "洗车服务"}</small></span><em>{dashboardOrderStatusLabels[order.status] || "状态待核对"}</em><CaretRight /></button>)}</div> : <p className="provider-empty">{loading ? "正在读取最近订单…" : "暂无近期订单"}</p>}</section>
      <section className="content-card provider-recent-audit"><header><div><small>最近操作</small><h2>最近操作</h2></div><button onClick={() => onNavigate("/my-audit")}>我的记录<CaretRight /></button></header>{events.length ? <ol>{events.slice(0, 8).map((event) => <li key={event.id}><i /><span><strong>{event.actionLabel}</strong><small>{event.summary} · {localDate(auditTime(event))}</small></span><em className={`backoffice-audit-outcome ${event.outcome.code}`}>{event.outcome.label}</em></li>)}</ol> : <p className="provider-empty">{loading ? "正在读取最近操作…" : "暂无操作记录"}</p>}</section></div>
  </div>;
}

type SettlementOrder = { orderId: string; orderNumber: string; appointmentDate: string; startTime: string; endTime: string; orderStatus: string; orderAmountFen: number; status: string; amountFen: number | null; settledAt?: string | null };

export function WashProviderSettlementsPage({ onError }: { onError: (message: string) => void }) {
  const [orders, setOrders] = useState<SettlementOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const pageSize = 25;
  useEffect(() => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) query.set("settlementStatus", status);
    setLoading(true);
    if (status) { query.delete("settlementStatus"); query.set("status", status); }
    void api<ListPayload<SettlementOrder>>(`/admin/wash/settlements?${query}`).then((payload) => {
      const items = listOf(payload);
      setOrders(items);
      setTotalCount(Array.isArray(payload) ? items.length : payload.total ?? items.length);
    }).catch((reason) => onError(operatorErrorMessage(reason, "对账记录读取失败，请稍后重试"))).finally(() => setLoading(false));
  }, [onError, page, status]);
  const pageAmount = orders.reduce((sum, order) => sum + (order.amountFen ?? 0), 0);
  return <>
    <section className="provider-settlement-summary"><div><small>筛选结果</small><strong>{totalCount}<em> 笔</em></strong></div><div><small>本页对账金额</small><strong>¥{money(pageAmount)}</strong></div><p><ShieldCheck weight="duotone" /><span><strong>只读对账记录</strong><small>平台负责登记与修正，本门店只能核对结果。</small></span></p></section>
    <section className="content-card provider-settlement-card"><header><div><small>线下对账</small><h2>对账记录</h2></div><label><span>结算状态</span><select aria-label="服务商对账状态" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}><option value="">全部状态</option><option value="unsettled">待对账</option><option value="settled">已对账</option><option value="void">不适用</option></select></label></header><div className="table-wrap"><table><thead><tr><th>订单</th><th>服务日期</th><th>服务时段</th><th>订单金额</th><th>对账金额</th><th>状态</th><th>对账时间</th></tr></thead><tbody>{orders.map((order) => <tr key={order.orderId}><td><strong>{order.orderNumber}</strong></td><td><strong>{order.appointmentDate}</strong></td><td><strong>{order.startTime}–{order.endTime}</strong></td><td><strong>¥{money(order.orderAmountFen)}</strong></td><td><strong>{order.amountFen == null ? "—" : `¥${money(order.amountFen)}`}</strong></td><td><span className={`settlement-pill settlement-${order.status}`}>{order.status === "settled" ? "已对账" : order.status === "void" ? "不适用" : "待对账"}</span></td><td><strong>{localDate(order.settledAt)}</strong></td></tr>)}</tbody></table>{loading ? <div className="table-loading">正在读取对账记录…</div> : !orders.length ? <div className="empty-table">当前没有对账记录</div> : null}</div><footer className="backoffice-pagination"><span>共 <strong>{totalCount}</strong> 条本店记录</span><div><button disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><CaretLeft />上一页</button><span>第 {page} 页</span><button disabled={page * pageSize >= totalCount || loading} onClick={() => setPage((value) => value + 1)}>下一页<CaretRight /></button></div></footer></section>
  </>;
}
