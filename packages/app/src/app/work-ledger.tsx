import { WorkLedgerScreen } from "@/screens/work-ledger-screen";

/**
 * The cross-host index: every daemon this device is connected to, in one list.
 * The per-host route under `/h/[serverId]/work-ledger` stays for the workspace
 * header popup, which is scoped to the host the user is looking at.
 */
export default function WorkLedgerAllHostsRoute() {
  return <WorkLedgerScreen />;
}
