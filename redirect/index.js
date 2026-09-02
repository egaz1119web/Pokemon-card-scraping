// 旧ホスト（pokemon-card-scraping.op-sarada.workers.dev）を、
// 新ホスト（pokedeck.op-sarada.workers.dev）へ飛ばすだけの Worker。
//
// Worker には改名が無く、名前を変えると別の Worker ができて旧ホストが
// 空になる。配信中のアプリはホストを直書きしているので、そのままだと
// カードデータの更新が止まる（Android の ApiProvider、iOS の
// ArticleListAPIClient）。ここを噛ませておけば、旧バージョンのままでも
// 取り続けられる。OkHttp も URLSession も既定でリダイレクトを追う。
//
// 301（恒久）にしてあるので、一度踏んだ端末は次から直接新ホストへ行く。
// 旧バージョンが世の中から消えたら、この Worker ごと消してよい。

const NEW_HOST = "pokedeck.op-sarada.workers.dev";

export default {
  fetch(request) {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = NEW_HOST;
    // ホスト名だけ差し替えても port は残る。http で来たときに
    // 変な行き先を返さないよう、明示的に消しておく。
    url.port = "";
    return Response.redirect(url.toString(), 301);
  },
};
