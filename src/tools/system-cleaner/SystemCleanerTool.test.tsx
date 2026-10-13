import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emitMockEvent } from "../../test/tauri-mock";
import SystemCleanerTool from "./SystemCleanerTool";

/**
 * 面板的可测行为。
 *
 * 重点是**后端说了算**的那几件事：
 * - 空间账目分栏（「可立即释放」与「隔离区暂存」必须分开显示，§10.2）；
 * - 不可恢复项要经过一次确认，且确认是带着 `confirmedUnrecoverable: true`
 *   再往后端发一次的（后端会自己裁决，前端只负责把话转述给用户）。
 */

const mockInvoke = vi.mocked(invoke);

const RECYCLE_BIN_RULE = {
  id: "recycle-bin",
  name: "回收站",
  group: "system" as const,
  tier: "L1" as const,
  requiresAdmin: false,
  defaultChecked: false,
  consequence: "永久删除所有固定磁盘回收站内的全部内容，不可撤销。",
  undo: "none" as const,
  guard: [{ kind: "confirmUnrecoverable" }],
  strategy: { kind: "shellEmptyRecycleBin" },
};

const TEMP_RULE = {
  id: "temp-user",
  name: "用户临时文件",
  group: "cache" as const,
  tier: "L1" as const,
  requiresAdmin: false,
  defaultChecked: true,
  consequence: "只删除 7 天前、且当前未被占用的临时文件。",
  undo: "none" as const,
  guard: [],
  strategy: { kind: "purgeContents", olderThanDays: 7 },
};

/** 第三条规则：只在「确认条期间改勾选」那条用例里用得上（充当"从没扫过"的那一项）。 */
const CACHE_RULE = {
  id: "browser-cache",
  name: "浏览器缓存",
  group: "cache" as const,
  tier: "L1" as const,
  requiresAdmin: false,
  defaultChecked: false,
  consequence: "删除各浏览器的缓存目录。",
  undo: "none" as const,
  guard: [],
  strategy: { kind: "purgeContents", olderThanDays: 0 },
};

const LEDGER = {
  immediateBytes: 3 * 1024 * 1024 * 1024,
  pendingQuarantineBytes: 0,
  quarantineBytes: 512 * 1024 * 1024,
  quarantineUserDataBytes: 64 * 1024 * 1024,
  needsConfirmBytes: 0,
};

type CommandStub = (args?: Record<string, unknown>) => unknown;

function stubCommands(overrides: Record<string, CommandStub> = {}) {
  // `invoke` 的入参类型是 `InvokeArgs`（可能是数组或二进制），比这里的桩宽。
  // 用 `never` 收口参数位，避免为这点测试代码引入对 InvokeArgs 的依赖。
  mockInvoke.mockImplementation((async (command: string, raw?: unknown) => {
    const args = (raw ?? undefined) as Record<string, unknown> | undefined;
    const override = overrides[command];
    if (override) return override(args);
    switch (command) {
      case "disk_cleanup_rules":
        return { rules: [TEMP_RULE, RECYCLE_BIN_RULE], rulesError: null };
      case "disk_cleanup_volumes":
        return [
          {
            mountPoint: "C:\\",
            totalBytes: 274_877_906_944,
            freeBytes: 39_400_000_000,
            isSystem: true,
          },
        ];
      case "get_system_cleaner_quarantine_days":
        return 7;
      case "disk_cleanup_quarantine_list":
        return [];
      case "disk_cleanup_quarantine_summary":
        return [512 * 1024 * 1024, 64 * 1024 * 1024];
      default:
        return null;
    }
  }) as never);
}

async function mount() {
  const view = render(<SystemCleanerTool />);
  // 挂载时那几条 invoke 是异步的，等它们落地
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

/** 让后端推一份状态快照过来（进度走的是这条事件）。 */
async function pushStatus(payload: Record<string, unknown>) {
  await act(async () => {
    emitMockEvent("disk-cleanup-status", payload);
    await Promise.resolve();
  });
}

/** 让后端推一份占用发现快照过来。 */
async function pushDiscovery(payload: Record<string, unknown>) {
  await act(async () => {
    emitMockEvent("disk-cleanup-discovery", payload);
    await Promise.resolve();
  });
}

/** 展开一个高级分区折叠行（空间分析 / 隔离区 / 审计日志）。 */
async function openFold(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

/** 推一份「扫描完成（ready）」的状态快照：只有报告列表是变化的。 */
async function pushReports(reports: Array<Record<string, unknown>>) {
  await pushStatus({
    jobId: "1",
    phase: "ready",
    dryRun: true,
    currentRule: null,
    progress: null,
    reports,
    totals: {},
    advice: [],
    ledger: LEDGER,
    discoveries: [],
    error: null,
    rulesError: null,
  });
}

/** 构造一条规则报告：组件只读其中几个字段，其余给零值。 */
function ruleReport(ruleId: string, overrides: Record<string, unknown> = {}) {
  return {
    ruleId,
    ruleName: "",
    tier: "L1",
    status: "ok",
    targetDisplay: "C:\\Users\\me\\AppData\\Local\\Temp",
    files: 0,
    dirs: 0,
    bytesDeleted: 0,
    quarantined: 0,
    bytesQuarantined: 0,
    skippedInUse: 0,
    skippedTooRecent: 0,
    readonlySkipped: 0,
    reparseSkipped: 0,
    vanished: 0,
    bytesVanished: 0,
    failures: 0,
    samplePaths: [],
    error: null,
    ...overrides,
  };
}

/** 某条规则行的根节点（用勾选框反查，避免依赖行内的中文文案）。 */
function ruleRow(name: RegExp): Element {
  const row = screen.getByRole("checkbox", { name }).closest(".cleaner-rule");
  if (!row) throw new Error(`没找到规则行：${name}`);
  return row;
}

/** 某条规则行右侧的体积文字。 */
function ruleSize(name: RegExp): string {
  const cell = ruleRow(name).querySelector(".cleaner-rule-size");
  if (!cell) throw new Error(`这一行没有体积列：${name}`);
  return cell.textContent ?? "";
}

/** 展开某条规则的详情（点那一行的 ⓘ）。 */
async function toggleRuleDetail(name: RegExp) {
  const info = ruleRow(name).querySelector(".cleaner-info");
  if (!info) throw new Error(`这一行没有详情入口：${name}`);
  await act(async () => {
    fireEvent.click(info);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubCommands();
});

describe("SystemCleanerTool", () => {
  it("渲染清理项，并且默认只勾选安全项（回收站不默认勾选）", async () => {
    await mount();
    await pushStatus({
      jobId: "1",
      phase: "ready",
      dryRun: true,
      currentRule: null,
      progress: null,
      reports: [],
      totals: {},
      advice: [],
      ledger: LEDGER,
      discoveries: [],
      error: null,
      rulesError: null,
    });

    expect(screen.getByText("系统清理")).toBeInTheDocument();
    const temp = screen.getByRole("checkbox", { name: /用户临时文件/ }) as HTMLInputElement;
    const recycle = screen.getByRole("checkbox", { name: /回收站/ }) as HTMLInputElement;
    expect(temp.checked).toBe(true);
    expect(recycle.checked).toBe(false);
    expect(screen.getByText("需确认")).toBeInTheDocument();
  });

  it("空间账目分栏：「可立即释放」与「隔离区暂存」分开显示", async () => {
    await mount();
    await pushStatus({
      jobId: "1",
      phase: "ready",
      dryRun: true,
      currentRule: null,
      progress: null,
      reports: [],
      totals: {},
      advice: [],
      ledger: LEDGER,
      discoveries: [],
      error: null,
      rulesError: null,
    });

    // 三格统计头：第一格（强调色）是可立即释放，第二格单独给隔离区
    expect(screen.getByText("可立即释放")).toBeInTheDocument();
    expect(screen.getByText("3.0 GB")).toBeInTheDocument();
    expect(screen.getByText("隔离区暂存")).toBeInTheDocument();
    expect(screen.getByText("512 MB")).toBeInTheDocument();
    // 账目细分（用户数据部分）不占主视图，收在「隔离区」折叠区里
    await openFold(/隔离区/);
    expect(screen.getByText(/其中属于用户数据，不会被自动删除/)).toBeInTheDocument();
    expect(screen.getByText(/64\.0 MB/)).toBeInTheDocument();
  });

  it("未扫描前不给执行清理", async () => {
    await mount();
    const start = screen.getByRole("button", { name: "清理所选项目" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("请先扫描一次");
  });

  it("扫过 A 之后再勾上从没扫过的 B：清理按钮必须灭掉（否则 B 会被删且没预览过）", async () => {
    await mount();
    // 只扫了默认勾选的「用户临时文件」
    await pushReports([ruleReport("temp-user")]);
    const start = screen.getByRole("button", { name: "清理所选项目" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);

    // 再勾上回收站：它没有本轮报告，界面上从没展示过它会删掉哪些东西。
    // 判据必须是"勾选项都扫过"，只看"扫过一次"这里就会亮着。
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /回收站/ }));
      await Promise.resolve();
    });
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("回收站");
    // 原因还必须是**看得见**的文本：disabled 按钮的 title 在 WebView2 下弹不出来
    expect(screen.getByText(/还有 1 项未扫描/)).toBeInTheDocument();

    // 连它一起重扫之后才放行
    await pushReports([ruleReport("temp-user"), ruleReport("recycle-bin")]);
    expect(start.disabled).toBe(false);
  });

  it("确认条挂在那儿时再勾一项：确认作废（否则没扫过的项能借「确认执行」被删掉）", async () => {
    // 多一条规则：默认勾的临时文件、需确认的回收站、以及从没扫过的浏览器缓存
    stubCommands({
      disk_cleanup_rules: () => ({
        rules: [TEMP_RULE, RECYCLE_BIN_RULE, CACHE_RULE],
        rulesError: null,
      }),
      disk_cleanup_start: () => {
        throw new Error("以下清理项的内容不可恢复，需要你确认：回收站");
      },
    });
    await mount();
    await pushReports([ruleReport("temp-user"), ruleReport("recycle-bin")]);

    // 勾上回收站（两项都已扫过），点清理 → 后端要确认，确认条出现
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /回收站/ }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清理所选项目" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("内容不可恢复")).toBeInTheDocument();

    // 再勾上从没扫描过的浏览器缓存：「确认执行」发的是**此刻**的勾选，
    // 所以确认条必须跟着作废，否则它会跟着一起被删，而界面上从没预览过它。
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /浏览器缓存/ }));
      await Promise.resolve();
    });
    expect(screen.queryByText("内容不可恢复")).not.toBeInTheDocument();
    const start = screen.getByRole("button", { name: "清理所选项目" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("「全选」一次勾上全部清理项，「全不选」一次取消（按钮文案随状态翻面）", async () => {
    stubCommands({
      disk_cleanup_rules: () => ({
        rules: [TEMP_RULE, CACHE_RULE, RECYCLE_BIN_RULE],
        rulesError: null,
      }),
    });
    await mount();

    const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    // 初始只勾了默认安全项
    expect(box(/用户临时文件/).checked).toBe(true);
    expect(box(/浏览器缓存/).checked).toBe(false);
    expect(box(/回收站/).checked).toBe(false);
    expect(screen.getByText("1/3 项")).toBeInTheDocument();

    // 全选：含标着「需确认」的回收站，计数随之对得上（少勾一项会让 n/N 看着像坏了）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全选" }));
      await Promise.resolve();
    });
    expect(box(/用户临时文件/).checked).toBe(true);
    expect(box(/浏览器缓存/).checked).toBe(true);
    expect(box(/回收站/).checked).toBe(true);
    expect(screen.getByText("3/3 项")).toBeInTheDocument();
    // 已经全勾上，按钮翻成「全不选」
    expect(screen.queryByRole("button", { name: "全选" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全不选" }));
      await Promise.resolve();
    });
    expect(box(/用户临时文件/).checked).toBe(false);
    expect(box(/浏览器缓存/).checked).toBe(false);
    expect(box(/回收站/).checked).toBe(false);
    expect(screen.getByText("0/3 项")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全选" })).toBeInTheDocument();
  });

  it("「全选」也要作废确认条：它会把没扫过的项一起带上", async () => {
    stubCommands({
      disk_cleanup_rules: () => ({
        rules: [TEMP_RULE, RECYCLE_BIN_RULE, CACHE_RULE],
        rulesError: null,
      }),
      disk_cleanup_start: () => {
        throw new Error("以下清理项的内容不可恢复，需要你确认：回收站");
      },
    });
    await mount();
    await pushReports([ruleReport("temp-user"), ruleReport("recycle-bin")]);

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /回收站/ }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清理所选项目" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("内容不可恢复")).toBeInTheDocument();

    // 全选把从没扫描过的「浏览器缓存」也勾上了 —— 与单项勾选同一条纪律：
    // 确认条必须作废，否则「确认执行」会连带删掉一个从没预览过的项。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全选" }));
      await Promise.resolve();
    });
    expect(screen.queryByText("内容不可恢复")).not.toBeInTheDocument();
    const start = screen.getByRole("button", { name: "清理所选项目" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/还有 1 项未扫描/)).toBeInTheDocument();
  });

  it("有任务在跑时不给全选（勾选框自己也是禁用的）", async () => {
    await mount();
    await pushDiscovery({
      jobId: "9",
      phase: "scanning",
      volume: "C:\\",
      reportDepth: 4,
      dirsVisited: 1,
      current: null,
      unreadableDirs: 0,
      entries: [],
    });
    expect((screen.getByRole("button", { name: "全选" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("有任务在跑时不让人确认：按钮禁用并写明原因，而不是点完弹红字", async () => {
    stubCommands({
      disk_cleanup_start: () => {
        throw new Error("以下清理项的内容不可恢复，需要你确认：回收站");
      },
    });
    await mount();
    await pushReports([ruleReport("temp-user"), ruleReport("recycle-bin")]);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /回收站/ }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清理所选项目" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const confirm = screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    // 占用发现扫描开跑 —— 后端重入闸门这时会拒掉清理，界面要抢先把这条路封上
    await pushDiscovery({
      jobId: "9",
      phase: "scanning",
      volume: "C:\\",
      reportDepth: 4,
      dirsVisited: 1,
      current: null,
      unreadableDirs: 0,
      entries: [],
    });
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/当前有任务在进行中/)).toBeInTheDocument();
  });

  it("不可恢复项要确认一次，确认后才带 confirmedUnrecoverable 再发一次", async () => {
    await mount();

    // 扫描结果要盖住**随后会勾上的每一项**：清理按钮的可用条件是「勾选项都扫过」，
    // 这里默认勾着临时文件、下面再勾回收站，两份报告都得在。
    await pushReports([ruleReport("temp-user"), ruleReport("recycle-bin")]);

    // 勾上回收站
    fireEvent.click(screen.getByRole("checkbox", { name: /回收站/ }));

    // 后端把「需要确认」当成错误返回；只覆盖这一条命令，其余仍走默认桩
    const startCalls: Array<Record<string, unknown>> = [];
    stubCommands({
      disk_cleanup_start: (args) => {
        startCalls.push(args ?? {});
        if (!args?.confirmedUnrecoverable) {
          throw new Error("以下清理项的内容不可恢复，需要你确认：回收站");
        }
        return null;
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清理所选项目" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].confirmedUnrecoverable).toBe(false);

    // 出现确认条，而不是红字报错
    expect(screen.getByText("内容不可恢复")).toBeInTheDocument();
    expect(screen.queryByText(/内容不可恢复，需要你确认/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1].confirmedUnrecoverable).toBe(true);
    // 确认条收起
    expect(screen.queryByText("内容不可恢复")).not.toBeInTheDocument();
  });

  it("无边框窗口自带关闭入口（调 hide 命令，窗口只是藏起来）", async () => {
    await mount();
    const close = screen.getByRole("button", { name: "关闭系统清理" });
    await act(async () => {
      fireEvent.click(close);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("hide_system_cleaner_window");
  });

  it("审计日志：展开时才去拉，且能按规则/路径筛选", async () => {
    await mount();
    // 折叠行展开即拉取；没展开之前不该去读用户路径
    expect(mockInvoke).not.toHaveBeenCalledWith("disk_cleanup_audit_list", expect.anything());

    stubCommands({
      disk_cleanup_audit_list: () => [
        { jobId: "1750000000000", modifiedAt: "2026-09-29T16:00:00+08:00", sizeBytes: 2048 },
      ],
      disk_cleanup_audit_read: () => [
        { kind: "header", ts: "2026-09-29T16:00:00+08:00", jobId: "1750000000000", ruleIds: [] },
        {
          kind: "entry",
          ts: "2026-09-29T16:00:01+08:00",
          ruleId: "temp-user",
          action: "deleted",
          path: "C:\\Users\\me\\AppData\\Local\\Temp\\a.tmp",
          bytes: 1024,
        },
        {
          kind: "entry",
          ts: "2026-09-29T16:00:02+08:00",
          ruleId: "recycle-bin",
          action: "failed",
          path: "<recycle-bin:fixed-volumes>",
          bytes: 0,
        },
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /审计日志/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("已删除")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument();

    // 筛选：按路径片段
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("规则 id 或路径片段"), {
        target: { value: "recycle" },
      });
      await Promise.resolve();
    });
    expect(screen.getByText(/共 1 条/)).toBeInTheDocument();
  });

  it("发现目标可以取消选择（只传 id，不传路径）", async () => {
    await mount();
    await pushStatus({
      jobId: "1",
      phase: "ready",
      dryRun: true,
      currentRule: null,
      progress: null,
      reports: [],
      totals: {},
      advice: [],
      ledger: LEDGER,
      freeBefore: null,
      freeAfter: null,
      discoveries: [
        {
          id: "d-000000000000009",
          displayPath: "D:\\BigCache",
          bytes: 4096,
          files: 2,
          isUserData: false,
        },
      ],
      error: null,
      rulesError: null,
    });

    // 已挑选的发现目标收在「隔离区」折叠区里，先展开
    await openFold(/隔离区/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("disk_cleanup_forget_discovery", {
      discoveryId: "d-000000000000009",
    });
  });

  it("隔离区为空时给出可操作的说明，而不是一片空白", async () => {
    await mount();
    await openFold(/隔离区/);
    expect(screen.getByText(/隔离区是空的/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /添加目录/ })).toBeInTheDocument();
  });

  it("占用发现：没有历史快照时明说「没有增量数据」，而不是显示 +0", async () => {
    await mount();
    await pushDiscovery({
      jobId: "9",
      phase: "done",
      volume: "C:\\",
      reportDepth: 4,
      dirsVisited: 1234,
      current: null,
      unreadableDirs: 3,
      entries: [
        {
          id: "d-000000000000001",
          path: "C:\\Users\\me\\AppData\\Local\\SomeCache",
          bytes: 5 * 1024 * 1024 * 1024,
          files: 12000,
          deltaBytes: null,
          deltaDays: null,
          isUserData: false,
          newestMtime: 0,
        },
        {
          // 没能过闸一的目标：没有 id
          id: null,
          path: "C:\\Windows\\System32",
          bytes: 1024,
          files: 4,
          deltaBytes: null,
          deltaDays: null,
          isUserData: false,
          newestMtime: 0,
        },
      ],
      baselineAt: null,
      baselineDays: null,
      lastSnapshotAt: "2026-09-29T13:00:00+08:00",
      error: null,
    });

    // 占用发现收在「空间分析」折叠区里
    await openFold(/空间分析/);
    expect(screen.getByText(/还没有更早的快照/)).toBeInTheDocument();
    expect(screen.getByText(/3 个目录读不到/)).toBeInTheDocument();
    expect(screen.getByText(/5\.0 GB · 12000 个文件/)).toBeInTheDocument();
    // 没有 id 的那一条不能给出清理入口
    const buttons = screen.getAllByRole("button", { name: "放入隔离区" }) as HTMLButtonElement[];
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
  });

  it("占用发现：有增量时列出「在增长」榜单", async () => {
    await mount();
    await pushDiscovery({
      jobId: "9",
      phase: "done",
      volume: "C:\\",
      reportDepth: 4,
      dirsVisited: 10,
      current: null,
      unreadableDirs: 0,
      entries: [
        {
          id: "d-000000000000002",
          path: "C:\\Users\\me\\AppData\\Local\\Temp\\Leaky",
          bytes: 17 * 1024 * 1024 * 1024,
          files: 1935,
          deltaBytes: 5 * 1024 * 1024 * 1024,
          deltaDays: 7,
          isUserData: false,
          newestMtime: 0,
        },
      ],
      baselineAt: "2026-09-22T13:00:00+08:00",
      baselineDays: 7,
      lastSnapshotAt: "2026-09-29T13:00:00+08:00",
      error: null,
    });

    await openFold(/空间分析/);
    expect(screen.getByText("在增长")).toBeInTheDocument();
    // 同一条会同时出现在「在增长」与「占用最大」两个榜单里
    expect(screen.getAllByText(/7 天内 \+5\.0 GB/).length).toBeGreaterThanOrEqual(1);
  });

  it("体积数字：没扫过写「未扫描」，扫过但没东西写「0 B」——两者不能是同一个符号", async () => {
    await mount();

    // 还没扫描：两项都要说清楚"还没扫过"，不能再借「——」这个"不可知"符号
    expect(ruleSize(/用户临时文件/)).toBe("未扫描");
    expect(ruleSize(/回收站/)).toBe("未扫描");

    await pushReports([
      ruleReport("temp-user"),
      ruleReport("recycle-bin", { bytesDeleted: 2 * 1024 ** 3 }),
    ]);

    // 扫过了：确实为空就是「0 B」，有东西就是真实体积
    expect(ruleSize(/用户临时文件/)).toBe("0 B");
    expect(ruleSize(/回收站/)).toBe("2.0 GB");
    expect(screen.queryByText("未扫描")).not.toBeInTheDocument();

    // 非 ok 状态下的 0 **不是**「0 B」：取消 / 失败时 stats 只统计到中断那一刻，
    // 那个 0 是"没量到"而不是"没有"，继续用「——」表示不可知。
    await pushReports([
      ruleReport("temp-user"),
      ruleReport("recycle-bin", { status: "cancelled" }),
    ]);
    expect(ruleSize(/用户临时文件/)).toBe("0 B");
    expect(ruleSize(/回收站/)).toBe("——");

    // 但真删掉了一些就照实显示 —— 宁可少报，不可多报
    await pushReports([
      ruleReport("temp-user"),
      ruleReport("recycle-bin", { status: "failed", bytesDeleted: 1024 * 1024 }),
    ]);
    expect(ruleSize(/回收站/)).toBe("1.0 MB");
  });

  it("详情里的「目标」同样区分「没扫过」与「扫过但没命中」", async () => {
    await mount();
    await toggleRuleDetail(/用户临时文件/);
    expect(screen.getByText(/目标：未扫描/)).toBeInTheDocument();

    // 扫过但没命中：`targetDisplay` 是空的，此时说"未扫描"是撒谎
    await pushReports([ruleReport("temp-user", { status: "no-target", targetDisplay: "" })]);

    expect(screen.getByText(/目标：本次没有可列出的目标/)).toBeInTheDocument();
    expect(ruleSize(/用户临时文件/)).toBe("未安装");
  });
});
