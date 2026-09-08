import * as Tabs from "@radix-ui/react-tabs";
import { Activity, ArrowUpRight, Bot, Inbox, LayoutDashboard, Settings2 } from "lucide-react";

export type WorkspacePage = "overview" | "approvals" | "agents" | "activity" | "system";
export const workspacePages = [
  { id: "overview", label: "Overview", description: "Your account, at a glance.", icon: LayoutDashboard },
  {
    id: "approvals",
    label: "Approvals",
    description: "Review what your agents want to do, before they do it.",
    icon: Inbox,
  },
  { id: "agents", label: "Agents", description: "Decide who can act, and within which limits.", icon: Bot },
  {
    id: "activity",
    label: "Activity",
    description: "Follow every decision from request to settlement.",
    icon: Activity,
  },
  {
    id: "system",
    label: "System",
    description: "Connections, policy and the state behind this account.",
    icon: Settings2,
  },
] as const;

export function WorkspaceNavigation({ page, pending }: { page: WorkspacePage; pending: number | null }) {
  return (
    <aside className="workspace-sidebar">
      <Tabs.List className="workspace-nav" aria-label="Workspace navigation">
        {workspacePages.map(({ id, label, icon: Icon }) => (
          <Tabs.Trigger key={id} value={id} data-testid={`nav-${id}`} aria-current={page === id ? "page" : undefined}>
            <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
            <span>{label}</span>
            {id === "approvals" && pending !== null && pending > 0 && <span className="nav-count">{pending}</span>}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <div className="sidebar-note">
        <ArrowUpRight size={22} strokeWidth={1.5} aria-hidden="true" />
        <strong>
          Agents propose.
          <br />
          You decide.
        </strong>
        <p>Every trade needs your exact approval.</p>
      </div>
    </aside>
  );
}
