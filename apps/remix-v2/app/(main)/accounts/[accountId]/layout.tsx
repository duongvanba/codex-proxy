import { Outlet, useParams } from "@remix-run/react";
import { HostsProvider } from "@context/hosts-context";

export default function Layout() {
  const { accountId } = useParams<{ accountId: string }>();
  return (
    <HostsProvider accountId={accountId!}>
      <div className="accounts-layout">
        <Outlet />
      </div>
    </HostsProvider>
  );
}
