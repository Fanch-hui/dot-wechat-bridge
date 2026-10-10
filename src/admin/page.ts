export function renderAdminPage():string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>微信成员 · Dot</title>
  <link rel="stylesheet" href="/admin/style.css">
  <script type="module" src="/admin/client.js"></script>
</head>
<body>
  <main class="workspace">
    <header class="page-header">
      <div><p class="eyebrow">DOT / 微信接入</p><h1>微信成员</h1></div>
      <button type="button" id="add-member" class="primary">添加成员</button>
    </header>
    <section class="service-bar" aria-label="服务状态">
      <span id="gateway-status" class="status">正在检查接入服务</span>
      <span id="events-status" class="status">正在检查 Dot 订阅</span>
      <button type="button" id="refresh" class="quiet">刷新</button>
    </section>
    <p id="page-error" class="error" role="alert" hidden></p>
    <p id="service-notice" class="notice" hidden></p>
    <section class="members-panel" aria-labelledby="members-heading">
      <div class="panel-header"><h2 id="members-heading">成员</h2><span id="member-count" class="muted">—</span></div>
      <div id="members" aria-busy="true"><p class="empty">正在读取成员…</p></div>
    </section>
    <p class="footer-note">成员消息会标明身份。同一个 Dot 的记忆可能共享。</p>
  </main>
  <dialog id="member-dialog" aria-labelledby="member-dialog-title">
    <form id="member-form">
      <div class="dialog-header"><h2 id="member-dialog-title">添加成员</h2><button type="button" class="close quiet" data-close="member-dialog" aria-label="关闭">×</button></div>
      <label for="member-name">称呼</label>
      <input id="member-name" name="display_name" maxlength="80" required autocomplete="off" placeholder="输入成员称呼">
      <p id="member-error" class="error" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-close="member-dialog">取消</button><button type="submit" id="member-submit" class="primary">添加并扫码</button></div>
    </form>
  </dialog>
  <dialog id="binding-dialog" aria-labelledby="binding-title">
    <div class="dialog-header"><div><p class="eyebrow">连接微信</p><h2 id="binding-title"></h2></div><button type="button" class="close quiet" data-close="binding-dialog" aria-label="关闭">×</button></div>
    <p id="binding-state" role="status" class="binding-state"></p>
    <div id="qr-region" hidden><div id="qr-code"></div><p id="qr-expiry" class="muted"></p><a id="download-qr" class="secondary download" download="wechat-qr.png">下载二维码</a></div>
    <form id="verify-form" hidden><label for="verify-code">微信验证码</label><div class="verify-fields"><input id="verify-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="64" required><button type="submit" id="verify-submit" class="primary">提交</button></div></form>
    <p id="binding-error" class="error" role="alert" hidden></p>
    <div class="dialog-actions"><button type="button" id="cancel-binding" class="secondary">取消绑定</button><button type="button" id="refresh-qr" class="primary" hidden>重新获取二维码</button><button type="button" id="binding-done" class="primary" hidden>完成</button></div>
  </dialog>
</body>
</html>`;
}
