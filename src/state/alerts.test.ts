// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ALERT_EXPIRY_CHOICES, MAX_ALERTS, type Alert, type AlertStorage, addAlert, alertBadge, alertExpiryFooter, alertExpiryLabel, alertLevel, alertText,
  alertsKey, autoFetchAlertText, dismissAutoFetchAlerts, projectsOfRepos, resolveAlertTarget, describeAlerts, dismissAlert, expireAlerts, formatAlertTime, loadAlerts, newAutoFetchFailures, saveAlerts,
} from "./alertsCore";

const HOUR = 3_600_000;

function fakeStorage(): AlertStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let n = 0;
const newId = () => `id${++n}`;
const input = (text: string, over: Partial<Alert> = {}) => ({ projectId: "p1", severity: "error" as const, text, ...over });

describe("add", () => {
  it("puts the newest alert first", () => {
    let list: Alert[] = [];
    list = addAlert(list, input("one"), 1000, newId);
    list = addAlert(list, input("two", { severity: "warning", repoName: "api" }), 2000, newId);
    expect(list.map((a) => a.text)).toEqual(["two", "one"]);
    expect(list[0]).toMatchObject({ projectId: "p1", severity: "warning", repoName: "api", time: 2000 });
    expect("repoName" in list[1]).toBe(false);
  });

  it("replaces the same text of the same repo instead of adding a duplicate", () => {
    let list: Alert[] = [];
    list = addAlert(list, input("Push rejected", { repoName: "api" }), 1000, newId);
    list = addAlert(list, input("other"), 1500, newId);
    const id = list[1].id;
    list = addAlert(list, input("Push rejected", { repoName: "api", severity: "warning" }), 3000, newId);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id, text: "Push rejected", time: 3000, severity: "warning" });
  });

  it("keeps the same text of another repo, or of no repo, as a separate alert", () => {
    let list: Alert[] = [];
    list = addAlert(list, input("Failed", { repoName: "api" }), 1, newId);
    list = addAlert(list, input("Failed", { repoName: "ledger" }), 2, newId);
    list = addAlert(list, input("Failed"), 3, newId);
    expect(list).toHaveLength(3);
  });

  it("keeps at most 100 alerts and drops the oldest", () => {
    let list: Alert[] = [];
    for (let i = 0; i < MAX_ALERTS + 5; i++) list = addAlert(list, input(`a${i}`), i, newId);
    expect(list).toHaveLength(MAX_ALERTS);
    expect(list[0].text).toBe(`a${MAX_ALERTS + 4}`);
    expect(list.at(-1)!.text).toBe("a5");
  });
});

describe("dismiss", () => {
  it("removes one alert by id and ignores an unknown id", () => {
    let list: Alert[] = [];
    list = addAlert(list, input("a"), 1, newId);
    list = addAlert(list, input("b"), 2, newId);
    const a = list.find((x) => x.text === "a")!;
    expect(dismissAlert(list, a.id).map((x) => x.text)).toEqual(["b"]);
    expect(dismissAlert(list, "nope")).toHaveLength(2);
  });
});

describe("expire", () => {
  const list: Alert[] = [
    { id: "1", projectId: "p1", severity: "error", text: "new", time: 10 * HOUR },
    { id: "2", projectId: "p1", severity: "error", text: "old", time: 1 * HOUR },
  ];
  it("removes the alerts older than the limit", () => {
    expect(expireAlerts(list, 10 * HOUR + 1, 4).map((a) => a.id)).toEqual(["1"]);
    expect(expireAlerts(list, 10 * HOUR, 24)).toBe(list); // nothing expired: same array
  });
  it("is exact at the limit: an alert of exactly N hours is gone", () => {
    expect(expireAlerts([list[1]], 2 * HOUR, 1)).toEqual([]);
    expect(expireAlerts([list[1]], 2 * HOUR - 1, 1)).toHaveLength(1);
  });
  it("never expires with 0 hours", () => {
    expect(expireAlerts(list, 10_000 * HOUR, 0)).toBe(list);
  });
});

describe("storage per project", () => {
  it("saves and loads under alerts.<projectId>, and keeps projects apart", () => {
    const st = fakeStorage();
    const a = addAlert([], input("a"), 5, newId);
    const b = addAlert([], input("b", { projectId: "p2" }), 6, newId);
    saveAlerts(st, "p1", a);
    saveAlerts(st, "p2", b);
    expect([...st.map.keys()].sort()).toEqual([alertsKey("p1"), alertsKey("p2")]);
    expect(alertsKey("p1")).toBe("deepgit.alerts.p1");
    expect(loadAlerts(st, "p1").map((x) => x.text)).toEqual(["a"]);
    expect(loadAlerts(st, "p2").map((x) => x.text)).toEqual(["b"]);
    expect(loadAlerts(st, "p3")).toEqual([]);
  });

  it("removes the key when the list is empty", () => {
    const st = fakeStorage();
    saveAlerts(st, "p1", addAlert([], input("a"), 5, newId));
    saveAlerts(st, "p1", []);
    expect(st.map.size).toBe(0);
  });

  it("survives garbage: bad JSON, a wrong shape, bad entries, a failing storage", () => {
    const st = fakeStorage();
    st.map.set(alertsKey("p1"), "{not json");
    expect(loadAlerts(st, "p1")).toEqual([]);
    st.map.set(alertsKey("p1"), '{"a":1}');
    expect(loadAlerts(st, "p1")).toEqual([]);
    const good: Alert = { id: "g", projectId: "p1", severity: "warning", text: "ok", time: 3 };
    st.map.set(alertsKey("p1"), JSON.stringify([good, { id: 1 }, null, { ...good, id: "x", severity: "info" }, { ...good, id: "y", projectId: "p9" }, { ...good, id: "z", time: "now" }]));
    expect(loadAlerts(st, "p1")).toEqual([good]);
    const broken: AlertStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(loadAlerts(broken, "p1")).toEqual([]);
    expect(() => saveAlerts(broken, "p1", [good])).not.toThrow();
    expect(() => saveAlerts(broken, "p1", [])).not.toThrow();
  });

  it("sorts newest first and caps at 100 on load", () => {
    const st = fakeStorage();
    const many: Alert[] = Array.from({ length: 120 }, (_, i) => ({ id: `i${i}`, projectId: "p1", severity: "error", text: `t${i}`, time: i }));
    st.map.set(alertsKey("p1"), JSON.stringify(many));
    const loaded = loadAlerts(st, "p1");
    expect(loaded).toHaveLength(100);
    expect(loaded[0].time).toBe(119);
  });
});

describe("widget text", () => {
  const mk = (...sev: ("error" | "warning")[]): Alert[] => sev.map((severity, i) => ({ id: String(i), projectId: "p", severity, text: "t", time: i }));
  it("describes the list for the tooltip and the aria-label", () => {
    expect(describeAlerts([], "IRIS")).toBe("No alerts");
    expect(describeAlerts(mk("error", "error", "warning"), "IRIS")).toBe("2 errors, 1 warning in IRIS");
    expect(describeAlerts(mk("warning"), "IRIS")).toBe("1 warning in IRIS");
    expect(describeAlerts(mk("error"), "IRIS")).toBe("1 error in IRIS");
  });
  it("picks the level and the badge", () => {
    expect(alertLevel([])).toBe("none");
    expect(alertLevel(mk("warning", "warning"))).toBe("warning");
    expect(alertLevel(mk("warning", "error"))).toBe("error");
    expect(alertBadge(7)).toBe("7");
    expect(alertBadge(99)).toBe("99");
    expect(alertBadge(100)).toBe("99+");
  });
  it("joins a title and a body in one sentence", () => {
    expect(alertText("Push rejected by origin", "Pull, then push again.")).toBe("Push rejected by origin. Pull, then push again.");
    expect(alertText("Could not push.", "Offline")).toBe("Could not push. Offline");
    expect(alertText("Failed", undefined)).toBe("Failed");
  });
  it("formats the time as dd-mm-yyyy HH:mm", () => {
    expect(formatAlertTime(new Date(2026, 10, 13, 14, 5).getTime())).toBe("13-11-2026 14:05");
    expect(formatAlertTime(new Date(2026, 0, 2, 9, 0).getTime())).toBe("02-01-2026 09:00");
  });
});

describe("expiry choices", () => {
  it("are in the order of the spec, with labels", () => {
    expect([...ALERT_EXPIRY_CHOICES].map(alertExpiryLabel)).toEqual(["1 hour", "4 hours", "24 hours", "3 days", "7 days", "Never"]);
    expect(alertExpiryFooter(24)).toBe("Alerts expire after 24 hours.");
    expect(alertExpiryFooter(0)).toBe("Alerts stay until you dismiss them.");
  });
});

describe("auto-fetch failures", () => {
  const fail = (repoId: string, failures = 1) => ({ repoId, message: "auth", failures });
  it("raises a failure once per attempt", () => {
    let r = newAutoFetchFailures(new Map(), [fail("a")], ["a", "b"]);
    expect(r.raise).toEqual([{ repoId: "a", message: "auth" }]);
    r = newAutoFetchFailures(r.reported, [fail("a")], ["a", "b"]); // same status again
    expect(r.raise).toEqual([]);
    r = newAutoFetchFailures(r.reported, [fail("a", 2), fail("b")], ["a", "b"]);
    expect(r.raise.map((x) => x.repoId)).toEqual(["a", "b"]);
  });
  it("reports a repo that fetches well again as recovered, and raises its next failure", () => {
    let r = newAutoFetchFailures(new Map(), [fail("a"), fail("b")], ["a", "b"]);
    r = newAutoFetchFailures(r.reported, [fail("b")], ["a", "b"]);
    expect(r.recovered).toEqual(["a"]);
    expect([...r.reported.keys()]).toEqual(["b"]);
    r = newAutoFetchFailures(r.reported, [fail("a"), fail("b")], ["a", "b"]);
    expect(r.raise.map((x) => x.repoId)).toEqual(["a"]);
  });
  it("keeps what it reported for the repos of another project: no recovery, no second alert on return", () => {
    let r = newAutoFetchFailures(new Map(), [fail("a")], ["a"]);
    r = newAutoFetchFailures(r.reported, [], ["x", "y"]); // switched to a project without a and without failures
    expect(r.recovered).toEqual([]);
    expect([...r.reported.keys()]).toEqual(["a"]);
    r = newAutoFetchFailures(r.reported, [fail("a")], ["a"]); // back: the same failure, already reported
    expect(r.raise).toEqual([]);
  });
  it("writes the alert text", () => {
    expect(autoFetchAlertText("authentication required")).toBe("Auto-fetch failed: authentication required.");
    expect(autoFetchAlertText("Could not resolve host.\n  Try later.")).toBe("Auto-fetch failed: Could not resolve host. Try later.");
    expect(autoFetchAlertText("  ")).toBe("Auto-fetch failed.");
  });
});

describe("auto-fetch alerts go away with the failure", () => {
  const mk = (id: string, over: Partial<Alert>): Alert => ({ id, projectId: "p1", severity: "warning", text: "t", time: 1, ...over });
  it("removes only the auto-fetch alerts of the repos that recovered", () => {
    const list = [
      mk("1", { source: "autoFetch", repoId: "a" }),
      mk("2", { source: "autoFetch", repoId: "b" }),
      mk("3", { repoId: "a" }), // a toast about the same repo stays
      mk("4", {}),
    ];
    expect(dismissAutoFetchAlerts(list, ["a"]).map((a) => a.id)).toEqual(["2", "3", "4"]);
    expect(dismissAutoFetchAlerts(list, [])).toBe(list);
    expect(dismissAutoFetchAlerts(list, ["zzz"])).toBe(list);
  });
  it("removes an alert saved by an earlier session when the repo fetches well, with no failure seen in this session", () => {
    const st = fakeStorage();
    const yesterday = new Date(2026, 10, 12, 9, 12).getTime();
    saveAlerts(st, "p1", [
      mk("old", { source: "autoFetch", repoId: "r1", repoName: "api", text: "Auto-fetch failed: authentication required.", time: yesterday }),
      mk("push", { severity: "error", text: "Push rejected.", repoId: "r1", time: yesterday }),
    ]);
    // a new session: nothing is known except what the storage has
    const loaded = loadAlerts(st, "p1");
    const projects = [{ id: "p1", repos: [{ id: "r1", name: "api" }] }, { id: "p2", repos: [{ id: "r9", name: "web" }] }];
    expect(projectsOfRepos(projects, ["r1"])).toEqual(["p1"]);
    expect(projectsOfRepos(projects, ["r1", "r9"])).toEqual(["p1", "p2"]);
    expect(projectsOfRepos(projects, ["zzz"])).toEqual([]);
    const kept = dismissAutoFetchAlerts(loaded, ["r1"]);
    saveAlerts(st, "p1", kept);
    expect(loadAlerts(st, "p1").map((a) => a.id)).toEqual(["push"]); // the failed push stays: only the auto-fetch alert goes
  });
  it("keeps the source and the repo id through the store", () => {
    const [a] = addAlert([], { projectId: "p1", severity: "warning", text: "t", repoName: "api", repoId: "r1", source: "autoFetch" }, 5, newId);
    expect(a).toMatchObject({ repoId: "r1", source: "autoFetch" });
    const st = fakeStorage();
    saveAlerts(st, "p1", [a]);
    expect(loadAlerts(st, "p1")).toEqual([a]);
  });
});

describe("which project an alert belongs to", () => {
  const projects = [
    { id: "p1", repos: [{ id: "r1", name: "api" }, { id: "r2", name: "ledger" }] },
    { id: "p2", repos: [{ id: "r3", name: "web" }, { id: "r4", name: "api" }] },
  ];
  it("uses the project id when given, even if another project is active", () => {
    expect(resolveAlertTarget(projects, { projectId: "p2" }, "p1")).toEqual({ projectId: "p2", repoId: undefined, repoName: undefined });
  });
  it("uses the project that owns the repo id, and fills the repo name", () => {
    expect(resolveAlertTarget(projects, { repoId: "r3" }, "p1")).toEqual({ projectId: "p2", repoId: "r3", repoName: "web" });
  });
  it("finds the project by repo name, the active project first", () => {
    expect(resolveAlertTarget(projects, { repoName: "api" }, "p2")).toEqual({ projectId: "p2", repoId: "r4", repoName: "api" });
    expect(resolveAlertTarget(projects, { repoName: "api" }, "p1")).toEqual({ projectId: "p1", repoId: "r1", repoName: "api" });
    expect(resolveAlertTarget(projects, { repoName: "web" }, "p1")).toMatchObject({ projectId: "p2", repoId: "r3" });
  });
  it("falls back to the active project, or nothing", () => {
    expect(resolveAlertTarget(projects, {}, "p1")?.projectId).toBe("p1");
    expect(resolveAlertTarget(projects, { repoName: "nope" }, "p2")?.projectId).toBe("p2");
    expect(resolveAlertTarget(projects, {}, undefined)).toBeUndefined();
    expect(resolveAlertTarget([], {}, "p1")).toBeUndefined();
  });
});
