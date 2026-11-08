// 時間のかかる処理（過去学習・FAQ案）のジョブキュー。
// LINEのWebhook内で動かすと30秒程度で打ち切られるため、KVに積んで5分ごとのcron（最大15分）で実行する。
import { sora } from "./line.js";

const PREFIX = "job:";
export const jobs = {
  async add(kv, job) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await kv.put(PREFIX + id, JSON.stringify({ ...job, id, at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 6 });
    return id;
  },
  async take(kv, max = 2) {
    const l = await kv.list({ prefix: PREFIX, limit: max });
    const out = [];
    for (const k of l.keys) { const j = await kv.get(k.name, "json"); await kv.delete(k.name); if (j) out.push(j); }
    return out;
  }
};

/** cron から：積まれたジョブを順に実行して、結果を依頼者にpushする */
export async function runJobs(env) {
  const list = await jobs.take(env.KV);
  if (!list.length) return { ran: 0 };
  const line = sora(env);
  for (const job of list) {
    const t0 = Date.now();
    let text;
    try {
      if (job.type === "faq-suggest") text = await faqSuggestJob(env, job);
      else if (job.type === "import-history") text = await importHistoryJob(env, job);
      else text = `⚠️ 不明なジョブ: ${job.type}`;
    } catch (e) {
      console.error("job error", job.type, e.message);
      text = `⚠️ ${job.type === "faq-suggest" ? "FAQ案" : "過去学習"}の処理に失敗しました：${e.message.slice(0, 200)}`;
    }
    console.log("job done", job.type, job.property, Math.round((Date.now() - t0) / 1000) + "s");
    try { await line.pushMessages(job.to, [{ type: "text", text: text.slice(0, 4900) }]); } catch (e) { console.error("job push error", e.message); }
  }
  return { ran: list.length };
}

async function faqSuggestJob(env, { property: p, days }) {
  const { suggestFaq } = await import("./learn.js");
  const r = await suggestFaq(env, p, days);
  if (r.error) return `⚠️ FAQ案の作成に失敗：${r.error}`;
  if (!r.candidates.length) return `${p}：過去${days}日（予約${r.bookings}件）に、FAQにできるやり取りが見つかりませんでした。`;
  const body = r.candidates.map((c, i) => `${i + 1}. ${c.needsAnswer ? "❓" : ""}Q: ${c.q}（${c.count}件）\n   A: ${c.a || "（返信例なし。回答を決めてください）"}${c.conflict ? `\n   ⚠️ 既存FAQ ${c.conflict} と食い違いあり` : ""}`).join("\n");
  return `💡 ${p} のFAQ案（過去${days}日・予約${r.bookings}件・やり取り${r.pairs}組）\n${body}\n\n採用：FAQ採用 ${p} 1 3 5（番号）／ FAQ採用 ${p} 全部\n❓は回答を決めてから「FAQ追加」で登録してください。`;
}

async function importHistoryJob(env, { property: p, days }) {
  const { importHistory } = await import("./learn.js");
  const r = await importHistory(env, p, days);
  if (r.error) return `⚠️ ${r.error}`;
  return `📚 ${r.property} 過去${r.days}日：予約${r.bookings}件・スレッド${r.threads}件から ${r.added} 組を学習例に追加（合計${r.total}件）\n「学習一覧 ${r.property}」で確認し、不要なものは「学習削除 ${r.property} 番号」で消してください。`;
}
