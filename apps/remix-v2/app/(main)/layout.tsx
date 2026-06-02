import { Outlet } from "@remix-run/react";
import { useAuth } from "@context/auth-context";

export default function MainLayout() {
  const { authenticated } = useAuth();
  if (!authenticated) return <div className="app-boot"><span className="inline-spinner" /></div>;
  return <Outlet />;
}
