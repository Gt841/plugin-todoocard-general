/**
 * 多设备发送的纯逻辑：目标归一化与批次结果汇总。
 * 真正的 BLE 传输仍逐台调用上游 CLI，避免并发抢蓝牙适配器。
 */

export interface SendTargetResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

export interface BatchSummary {
  ok: boolean;
  sent: number;
  failed: number;
  summary: string;
  /** 部分或全部失败时的明细，供日志与错误提示使用。 */
  error?: string;
}

/** 只保留已配对、去重后的 UUID；没传目标时回退到当前选中设备。 */
export function normalizeSendTargets(
  requested: string[] | null | undefined,
  pairedIds: string[],
  fallbackId: string | null | undefined,
): string[] {
  const paired = new Set(pairedIds.map((id) => String(id || "").toLowerCase()));
  const source = requested && requested.length ? requested : fallbackId ? [fallbackId] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const id = String(raw || "").toLowerCase();
    if (!paired.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function summarizeBatch(results: SendTargetResult[]): BatchSummary {
  if (!results.length) {
    return { ok: false, sent: 0, failed: 0, summary: "没有可发送的设备", error: "请至少选择一台已配对的卡片" };
  }
  const failedResults = results.filter((r) => !r.ok);
  const sent = results.length - failedResults.length;
  const failed = failedResults.length;
  if (!failed) {
    return {
      ok: true,
      sent,
      failed,
      summary: sent === 1 ? `发送成功：${results[0].name || results[0].id.slice(0, 8)}` : `已成功发送到 ${sent} 台卡片`,
    };
  }
  const names = failedResults.map((r) => r.name || r.id.slice(0, 8)).join("、");
  return {
    ok: false,
    sent,
    failed,
    summary: sent ? `已发送 ${sent} 台，失败 ${failed} 台` : `发送失败：${failed} 台`,
    error: `${names}：${failedResults.map((r) => r.error || "未知错误").join("；")}`,
  };
}
