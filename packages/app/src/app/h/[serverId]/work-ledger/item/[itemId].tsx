import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { WorkLedgerItemScreen } from "@/screens/work-ledger-item-screen";

export default function WorkLedgerItemRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    itemId?: string | string[];
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const itemId = typeof params.itemId === "string" ? params.itemId : "";
  return (
    <HostRouteBootstrapBoundary>
      <WorkLedgerItemScreen serverId={serverId} itemId={itemId} />
    </HostRouteBootstrapBoundary>
  );
}
