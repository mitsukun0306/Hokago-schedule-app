# Hokago-schedule-app

放課後予定共有アプリ「afterclass」

## ロール
・スクラムマスター：ちはな
・リポジトリオーナー：みつ

## ゴール

友達同士で放課後や休日の予定をゆるく共有し、「一緒に勉強する」「遊ぶ」「部活後にご飯」などを調整できるアプリ。

## 利用する技術

フロントエンド: HTML, CSS, JavaScript（ES Modules・ビルド不要）
データ・ログイン: Firebase（Cloud Firestore / Authentication）
公開: GitHub Pages

自分たちでサーバーを起動・管理する必要はありません。
（以前の Python サーバー版から方針を変更しました）

## 機能

| 機能 | できること |
| --- | --- |
| カレンダー | 月表示・週表示（時間軸）、今日へ移動、グループ別の絞り込み、日付タップで予定追加、週表示の空き枠クリックで予定追加 |
| スケジュール管理 | 予定の追加・編集・削除、終日／時間指定、繰り返し（毎日・毎週・毎月＋終了日）、場所・メモ、リマインダー、時間が重なる予定の警告、一覧・検索・絞り込み、出欠（参加／未定／不参加） |
| グループチャット | グループごとのリアルタイムチャット、未読数、予定カードの共有（チャットから出欠回答）、URL の自動リンク、自分のメッセージ削除、ブラウザ通知 |
| 共有 | 招待リンク・招待コード（LINE／メール／コピー／端末の共有機能）、予定リンク、予定のテキストコピー、`.ics` 書き出し（Google カレンダー・iPhone 等に取り込み可）、みんなの空き時間チェック |
| 通話 | グループでの音声・ビデオ通話（WebRTC）、ミュート、カメラ ON/OFF、画面共有、通話の最小化、着信通知 |

## Firebase の準備（最初に1回だけ）

1. https://console.firebase.google.com/ を開き、Google アカウントでログインして「プロジェクトを作成」
   （Google アナリティクスはオフで大丈夫です）
2. **Authentication** → 「始める」→ ログイン方法で次の2つを有効にする
   - 「匿名」（ゲストではじめる用）
   - 「Google」（ほかの端末でも同じアカウントを使う用）
3. **Authentication** → 設定 → **承認済みドメイン** に `mitsukun0306.github.io` を追加
4. **Firestore Database** → 「データベースを作成」→ 本番環境モード → ロケーションは `asia-northeast1`（東京）
5. **Firestore Database** → **ルール** に、このリポジトリの `firestore.rules` の中身を貼り付けて「公開」
6. プロジェクトの設定（歯車）→ 「マイアプリ」→ ウェブアプリ（`</>`）を追加
   → 表示された `firebaseConfig` の値を `js/firebase-config.js` に貼り付けてコミット

> `firebaseConfig` の値は公開されても問題ない情報です（データはルールで守られます）。
> ルールを貼り付け忘れると、誰でもデータを読み書きできてしまうので必ず行ってください。

## 公開（GitHub Pages）

1. GitHub のリポジトリ → **Settings** → **Pages**
2. Source を「Deploy from a branch」、Branch を `main` / `/(root)` にして Save
3. 数分後に **https://mitsukun0306.github.io/Hokago-schedule-app/** で使えるようになります

友だちには、この URL かグループの招待リンクを送るだけです。
https なので、スマホや別の PC からでもそのまま通話できます。

## 手元で動作確認する

ES Modules を使っているので、`index.html` をダブルクリックで開いても動きません。
VS Code の拡張機能「Live Server」で開くか、次のコマンドで確認用に開いてください（ファイルを見せるだけで、アプリのサーバーではありません）。

```bash
python3 -m http.server 5500
```

→ http://localhost:5500 を開く

## 構成

```
index.html              画面の骨組み
styles.css              デザイン
app.js                  起動・ログイン・画面切り替え・通知・リマインダー
firestore.rules         Firestore のセキュリティルール
js/firebase-config.js   Firebase の設定（ここに貼り付ける）
js/backend.js           Firebase とのやり取り（ログイン・保存・リアルタイム同期・通話の仲介）
js/state.js             アプリの状態
js/utils.js             日付・繰り返し・.ics などの共通処理
js/ui.js                モーダル・トースト・アイコン
js/calendar.js          カレンダー
js/schedule.js          予定一覧（スケジュール管理）
js/events.js            予定の作成・編集・詳細・共有
js/chat.js              グループチャット
js/groups.js            グループ・招待・空き時間
js/call.js              通話（WebRTC）
```

## データの持ち方（Firestore）

| コレクション | 中身 | 見られる人 |
| --- | --- | --- |
| `users` | ニックネーム・色・予定のある時間帯（タイトルなし） | ログインしている人 |
| `groups` | グループ名・メンバー・招待コード | メンバー |
| `groups/{id}/messages` | チャット | メンバー |
| `groups/{id}/call` | 通話中の参加者 | メンバー |
| `invites` | 招待コード → グループ | コードを知っている人 |
| `events` | 予定 | 自分だけの予定は本人、グループの予定はメンバー |
| `signals` | 通話をつなぐための一時的なデータ | 宛先の人 |

## 注意

- ゲストで始めた場合、ログアウトやブラウザのデータ削除をすると元のアカウントに戻れません。続けて使うなら、右上のメニューから「Google と連携」してください。
- 通話は参加者全員が直接つながる方式（メッシュ）なので、快適なのは 4〜5 人くらいまでです。
- 学校の Wi-Fi など、ネットワークによっては通話がつながらないことがあります。その場合は TURN サーバーを `js/firebase-config.js` の `iceServers` に設定してください。
- リマインダーはアプリを開いている間に通知されます。
- Firebase の無料枠（Spark プラン）で、友だち同士で使う規模なら十分動きます。
