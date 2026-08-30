import { ConnectionHub } from "./connection-hub.mjs";

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") {
    throw new Error(`connection_${label}_${method}_unavailable`);
  }
  return value[method].bind(value);
}

function selectOwnedLease(snapshot) {
  if (!snapshot?.running) return null;
  if (typeof snapshot.activeLeaseId === "string" && snapshot.activeLeaseId) {
    return snapshot.activeLeaseId;
  }

  const leases = Array.isArray(snapshot.leases)
    ? snapshot.leases.filter((lease) => lease && lease.running !== false)
    : [];
  if (leases.length !== 1 || typeof leases[0].leaseId !== "string" || !leases[0].leaseId) {
    // 不能按进程名猜测归属；多租约或缺少精确 ID 时宁可停止应用。
    throw new Error("connection_fusion_lease_ambiguous");
  }
  return leases[0].leaseId;
}

/**
 * 装配本机 Connections 应用事务。
 *
 * Router 仅在其管理面明确要求时重启；随后同步两类目录，并只替换当前
 * Fusion 精确拥有的租约。共享 WebGPT 生命周期不在此边界内。
 */
export function createLocalConnectionHub({
  router,
  sources = [],
  activity = null,
  profiles,
  runtime,
  secrets = null,
  open = null,
} = {}) {
  const getActive = requireMethod(profiles, "getActive", "profiles");
  const activate = requireMethod(runtime?.catalogBridge, "activate", "catalog");
  const inspectLauncher = requireMethod(runtime?.launcher, "inspect", "launcher");
  const restore = requireMethod(runtime?.launcher, "restore", "launcher");
  const launch = requireMethod(runtime?.launcher, "launch", "launcher");

  const hub = new ConnectionHub({
    router,
    sources,
    activity,
    secrets,
    applyBoundary: async ({ restartRequired }) => {
      const profile = await getActive();
      if (!profile) throw new Error("connection_active_profile_missing");

      if (restartRequired) {
        await requireMethod(router, "restart", "router")();
      }

      const codexCatalog = await activate({ target: "codex", profile });
      const externalCatalog = await activate({ target: "external", profile });

      const launcherSnapshot = await inspectLauncher();
      const previousLeaseId = selectOwnedLease(launcherSnapshot);
      if (previousLeaseId) await restore({ leaseId: previousLeaseId });
      const lease = await launch({ profile });

      return Object.freeze({
        catalogRevision: Object.freeze({
          codex: codexCatalog?.catalogRevision ?? null,
          external: externalCatalog?.catalogRevision ?? null,
        }),
        consumers: 6,
        previousLeaseId,
        leaseId: lease?.leaseId ?? null,
      });
    },
  });

  if (open !== null) {
    if (typeof open !== "function") throw new Error("connection_open_invalid");
    hub.open = open;
  }
  return hub;
}
