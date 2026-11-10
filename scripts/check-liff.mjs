// 画面（LIFF）のHTMLに埋め込んだスクリプトが、ブラウザで構文エラーにならないか確認する。
// テンプレート文字列の中の \n の書き間違いで画面が「読み込み中」のまま止まるのを防ぐ。 npm run check
const pages = [["./src/liff.js", "handleLiff", "/liff/linen"]];
let ng = 0;
for (const [file, fn, path] of pages) {
  const mod = await import(new URL("../" + file, import.meta.url));
  const html = await (await mod[fn](new Request("https://x" + path), { LIFF_ID: "x" }, new URL("https://x" + path))).text();
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new Function(m[1]); } catch (e) { ng++; console.error(`NG ${path}: ${e.message}`); }
  }
}
if (ng) process.exit(1); else console.log("OK: 画面のスクリプトに構文エラーなし");
