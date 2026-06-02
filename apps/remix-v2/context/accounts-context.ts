import { createContextFromHook, useCollection, useObservable } from "@livequery/react";
import { useEffect, useState } from "react";
import { combineLatest, of, switchMap } from "rxjs";
import type { LivequeryDocument } from "@livequery/client";
import type { AccountDoc } from "@codex/types";
import { useAuth } from "./auth-context";

export const [useAccounts, AccountsProvider] = createContextFromHook(() => {
  const { authenticated } = useAuth();
  // Collection `accounts` bị gate JWT ở backend → chỉ load khi đã có phiên đăng nhập,
  // tránh gọi GET /livequery/accounts khi chưa có account (sẽ 401).
  const accountsCollection = useCollection<AccountDoc>(authenticated && "accounts", { mode: "server-first", filters: {} });
  const accountDocs = useObservable(accountsCollection.items, []) as LivequeryDocument<AccountDoc>[];
  const accountsLoading = useObservable(accountsCollection.loading, null);
  const accountError = useObservable(accountsCollection.error, null);

  return {
    accountsCollection,
    accountDocs,
    accountsLoading,
    accountError,
    refreshAccounts: () => accountsCollection.query({}),
  };
});

/**
 * Snapshot LIVE của toàn bộ account. `collection.items` chỉ emit khi mảng đổi (thêm/bớt),
 * KHÔNG khi một doc đổi value ("modified"). Hook này combineLatest từng doc nên cập nhật cả
 * khi status/quota/selected của một account thay đổi — dùng cho phần tổng hợp (StatsGrid) cần
 * realtime đầy đủ thay vì đọc `doc.getValue()` một lần (không phản ứng "modified").
 */
export function useAccountSnapshots(): AccountDoc[] {
  const { accountsCollection } = useAccounts();
  const [snapshots, setSnapshots] = useState<AccountDoc[]>(() =>
    accountsCollection.items.getValue().map((doc) => doc.getValue())
  );
  useEffect(() => {
    const sub = accountsCollection.items
      .pipe(switchMap((docs) => (docs.length ? combineLatest(docs as LivequeryDocument<AccountDoc>[]) : of([] as AccountDoc[]))))
      .subscribe((values) => setSnapshots(values as AccountDoc[]));
    return () => sub.unsubscribe();
  }, [accountsCollection]);
  return snapshots;
}
