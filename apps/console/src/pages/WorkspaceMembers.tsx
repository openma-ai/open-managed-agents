import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Modal } from "../components/Modal";
import { useApi, setActiveTenantId } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { useAsyncAction } from "../hooks/useAsyncAction";

const copy = {
  en: {
    title: "Members",
    subtitle: "Manage who can access this workspace.",
    shared:
      "Members share workspace resources. Owners manage roles; admins can invite and remove members.",
    owner: "Owner",
    admin: "Admin",
    member: "Member",
    name: "Member",
    role: "Role",
    remove: "Remove",
    cancel: "Cancel",
    invite: "Create invitation link",
    invites: "Pending invitations",
    inviteHelp:
      "Anyone with the link can join once, within 7 days. Share it only with the intended person.",
    link: "Invitation link",
    copy: "Copy link",
    copied: "Copied",
    revoke: "Revoke",
    expires: "Expires",
    noInvites: "No pending invitations.",
    loading: "Loading members…",
    retry: "Retry",
    removeHelp:
      "They will lose access to this workspace and their personal API keys for it. Rotate shared workspace keys if they had a copy.",
    join: "Join workspace",
    joinHelp:
      "Accept this invitation to share the workspace’s resources with its members.",
    login: "Sign in to accept invitation",
    missing:
      "This invitation link is incomplete. Ask the workspace admin for a new link.",
    back: "Back to workspace",
    loadingAuth: "Checking sign-in…",
  },
  "zh-CN": {
    title: "成员",
    subtitle: "管理可访问此工作区的用户。",
    shared:
      "成员共享工作区资源。所有者可管理角色，管理员可邀请和移除普通成员。",
    owner: "所有者",
    admin: "管理员",
    member: "成员",
    name: "成员",
    role: "角色",
    remove: "移除",
    cancel: "取消",
    invite: "创建邀请链接",
    invites: "待接受的邀请",
    inviteHelp: "持有链接的人可在 7 天内加入一次，请仅分享给要邀请的人。",
    link: "邀请链接",
    copy: "复制链接",
    copied: "已复制",
    revoke: "撤销",
    expires: "到期时间",
    noInvites: "暂无待接受的邀请。",
    loading: "正在加载成员…",
    retry: "重试",
    removeHelp:
      "该用户将失去工作区访问权，其个人 API Key 也将失效。如果曾分享过工作区公共密钥，请更换这些密钥。",
    join: "加入工作区",
    joinHelp: "接受邀请后，你将与其他成员共享此工作区的资源。",
    login: "登录并接受邀请",
    missing: "邀请链接不完整，请向工作区管理员索取新链接。",
    back: "返回工作区",
    loadingAuth: "正在检查登录状态…",
  },
};
type Role = "owner" | "admin" | "member";
interface Member {
  user_id: string;
  name?: string;
  email?: string;
  role: Role;
}
interface Invitation {
  id: string;
  role: Role;
  expires_at: number;
}
interface Members {
  data: Member[];
  role: Role;
  user_id: string;
}

export function WorkspaceMembers() {
  const { api } = useApi();
  const { locale } = useI18n();
  const t = copy[locale];
  const [workspace, setWorkspace] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [members, setMembers] = useState<Members | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const load = useCallback(async () => {
    const me = await api<{ tenant: { id: string; name: string } }>(
      "/v1/oma/me",
    );
    const base = `/v1/oma/tenants/${encodeURIComponent(me.tenant.id)}`;
    const result = await api<Members>(`${base}/members`);
    const pending =
      result.role === "member"
        ? []
        : (await api<{ data: Invitation[] }>(`${base}/invitations`)).data;
    setWorkspace(me.tenant);
    setMembers(result);
    setInvitations(pending);
  }, [api]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const action = useAsyncAction(async (work: () => Promise<void>) => {
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });
  const base = `/v1/oma/tenants/${encodeURIComponent(workspace?.id ?? "")}`;
  const canManage = members?.role === "owner" || members?.role === "admin";
  const createInvite = () =>
    action.run(async () => {
      const result = await api<{ token: string }>(`${base}/invitations`, {
        method: "POST",
        body: JSON.stringify({ role: inviteRole }),
      });
      setLink(`${window.location.origin}/join#${result.token}`);
      setCopied(false);
    });
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 p-4 sm:p-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-fg">{t.title}</h1>
        <p className="text-sm text-fg-muted">
          {workspace?.name ? `${workspace.name} · ` : ""}
          {t.subtitle}
        </p>
      </header>
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void refresh()}>
            {t.retry}
          </Button>
        </div>
      )}
      {loading ? (
        <p role="status" className="text-sm text-fg-muted">
          {t.loading}
        </p>
      ) : (
        members && (
          <>
            <section className="space-y-4" aria-label={t.title}>
              <p className="max-w-2xl text-sm text-fg-muted">{t.shared}</p>
              <ul className="divide-y divide-border border-y border-border">
                {members.data.map((member) => {
                  const name = member.name || member.email || member.user_id;
                  const removable =
                    member.role !== "owner" &&
                    (members.role === "owner" ||
                      (members.role === "admin" && member.role === "member"));
                  return (
                    <li
                      key={member.user_id}
                      className="flex flex-wrap items-center justify-between gap-3 py-4"
                    >
                      <div className="min-w-0 flex-1 basis-40">
                        <p className="break-words text-sm font-medium text-fg">
                          {name}
                        </p>
                        {member.email && (
                          <p className="break-all text-sm text-fg-muted">
                            {member.email}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        {members.role === "owner" && member.role !== "owner" ? (
                          <Select
                            value={member.role}
                            disabled={action.loading}
                            onValueChange={(role) =>
                              void action.run(async () => {
                                await api(
                                  `${base}/members/${encodeURIComponent(member.user_id)}`,
                                  {
                                    method: "PATCH",
                                    body: JSON.stringify({ role }),
                                  },
                                );
                              })
                            }
                          >
                            <SelectTrigger aria-label={`${t.role}: ${name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="member">{t.member}</SelectItem>
                              <SelectItem value="admin">{t.admin}</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-sm text-fg-muted">
                            {t[member.role]}
                          </span>
                        )}
                        {removable && (
                          <Button
                            variant="ghost"
                            disabled={action.loading}
                            aria-label={`${t.remove} ${name}`}
                            onClick={() => {
                              setError("");
                              setRemoving(member);
                            }}
                          >
                            {t.remove}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
            {canManage && (
              <section
                className="space-y-4"
                aria-labelledby="workspace-invitations"
              >
                <h2
                  id="workspace-invitations"
                  className="text-base font-semibold text-fg"
                >
                  {t.invites}
                </h2>
                <p className="max-w-2xl text-sm text-fg-muted">
                  {t.inviteHelp}
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  {members.role === "owner" && (
                    <div className="space-y-2">
                      <Label htmlFor="invite-role">{t.role}</Label>
                      <Select
                        value={inviteRole}
                        onValueChange={(role) =>
                          setInviteRole(role as "admin" | "member")
                        }
                        disabled={action.loading}
                      >
                        <SelectTrigger id="invite-role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">{t.member}</SelectItem>
                          <SelectItem value="admin">{t.admin}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button
                    onClick={() => void createInvite()}
                    disabled={action.loading}
                  >
                    {t.invite}
                  </Button>
                </div>
                {link && (
                  <div className="space-y-2">
                    <Label htmlFor="invitation-link">{t.link}</Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="invitation-link"
                        className="min-w-0 flex-1 basis-56"
                        readOnly
                        value={link}
                        onFocus={(e) => e.target.select()}
                      />
                      <Button
                        variant="outline"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(link);
                            setCopied(true);
                          } catch (e) {
                            setError(
                              e instanceof Error ? e.message : String(e),
                            );
                          }
                        }}
                      >
                        {copied ? t.copied : t.copy}
                      </Button>
                    </div>
                  </div>
                )}
                {invitations.length === 0 ? (
                  <p className="text-sm text-fg-muted">{t.noInvites}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {invitations.map((invitation) => (
                      <li
                        key={invitation.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <div>
                          <p className="text-sm text-fg">
                            {t[invitation.role]}
                          </p>
                          <p className="text-sm text-fg-muted">
                            {t.expires}:{" "}
                            {new Date(invitation.expires_at).toLocaleString(
                              locale,
                            )}
                          </p>
                        </div>
                        {(members.role === "owner" ||
                          invitation.role === "member") && (
                          <Button
                            variant="ghost"
                            disabled={action.loading}
                            onClick={() =>
                              void action.run(async () => {
                                await api(
                                  `${base}/invitations/${invitation.id}`,
                                  { method: "DELETE" },
                                );
                                setLink("");
                              })
                            }
                          >
                            {t.revoke}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )
      )}
      <Modal
        open={!!removing}
        title={`${t.remove} ${removing?.name || removing?.email || removing?.user_id || ""}`}
        onClose={() => {
          if (!action.loading) {
            setRemoving(null);
            setError("");
          }
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={action.loading}
              onClick={() => {
                setRemoving(null);
                setError("");
              }}
            >
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={action.loading}
              onClick={() =>
                void action.run(async () => {
                  if (!removing) return;
                  await api(
                    `${base}/members/${encodeURIComponent(removing.user_id)}`,
                    { method: "DELETE" },
                  );
                  setRemoving(null);
                })
              }
            >
              {t.remove}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted">{t.removeHelp}</p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </Modal>
    </div>
  );
}

export function JoinWorkspace() {
  const { api } = useApi();
  const { locale } = useI18n();
  const t = copy[locale];
  const auth = useAuth();
  const location = useLocation();
  const token = location.hash.slice(1);
  const [error, setError] = useState("");
  const join = useAsyncAction(async () => {
    setError("");
    try {
      const result = await api<{ tenant_id: string }>(
        "/v1/oma/tenants/invitations/accept",
        {
          method: "POST",
          headers: { "x-active-tenant": "" },
          body: JSON.stringify({ token }),
        },
      );
      setActiveTenantId(result.tenant_id);
      window.location.replace("/members");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 p-6">
      <h1 className="text-2xl font-semibold text-fg">{t.join}</h1>
      <p className="text-sm text-fg-muted">{token ? t.joinHelp : t.missing}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {token &&
        (auth.isLoading ? (
          <p role="status">{t.loadingAuth}</p>
        ) : auth.isAuthenticated ? (
          <Button disabled={join.loading} onClick={() => void join.run()}>
            {t.join}
          </Button>
        ) : (
          <Button asChild>
            <Link
              to={`/login?next=${encodeURIComponent(location.pathname + location.hash)}`}
            >
              {t.login}
            </Link>
          </Button>
        ))}
      <Link
        to="/"
        className="text-sm text-fg-muted underline underline-offset-4"
      >
        {t.back}
      </Link>
    </main>
  );
}
