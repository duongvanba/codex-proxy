import { createContextFromHook, useCollection } from "@livequery/react";
import type { HostDoc } from "@codex/types";

export const [useHosts, HostsProvider] = createContextFromHook(
  ({ accountId }: { accountId: string }) => {
    const hostsCollection = useCollection<HostDoc>(
      `accounts/${accountId}/hosts`,
      { mode: "local-first", filters: {} }
    );
    return { hostsCollection };
  }
);
