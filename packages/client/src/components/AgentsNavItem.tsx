import { useGlobalActiveAgents } from "../hooks/useGlobalActiveAgents";
import { SidebarIcons, SidebarNavItem } from "./SidebarNavItem";

interface AgentsNavItemProps {
  /** Called when item is clicked (e.g., to close mobile sidebar) */
  onClick?: () => void;
}

/**
 * Agents navigation item with built-in activity indicator.
 * Use this component instead of manually wiring up SidebarNavItem for agents
 * to ensure consistent behavior across all sidebars.
 */
export function AgentsNavItem({ onClick }: AgentsNavItemProps) {
  const activeAgentsCount = useGlobalActiveAgents();

  return (
    <SidebarNavItem
      to="/agents"
      icon={SidebarIcons.agents}
      label="Agents"
      onClick={onClick}
      hasActivityIndicator={activeAgentsCount > 0}
    />
  );
}
