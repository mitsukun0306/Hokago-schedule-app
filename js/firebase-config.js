// Firebase の設定
// Firebase コンソール → プロジェクトの設定 → 「マイアプリ」（ウェブアプリ）に表示される
// firebaseConfig の中身を、下の値に貼り付けてください。
// （この値は公開されても問題ありません。データは firestore.rules で守られます）
//
// projectId を "demo-" で始まる名前にすると、ローカルの Firebase エミュレーターにつながります。
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// 通話の接続に使う ICE サーバー。null なら Google の公開 STUN を使います。
// 別々のネットワーク同士でつながらないときは、TURN サーバーをここに追加します。
// 例: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }]
export const iceServers = null;
