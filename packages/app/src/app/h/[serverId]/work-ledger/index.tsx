import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { WorkLedgerScreen } from "@/screens/work-ledger-screen";

export default function WorkLedgerRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <WorkLedgerScreen />
    </HostRouteBootstrapBoundary>
  );
}
