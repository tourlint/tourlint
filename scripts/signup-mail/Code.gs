/** TourLint 인증메일 전용. Apps Script의 Code.gs에 이 파일 전체를 붙여 넣는다. */
function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 2048) return result_(false);
    var request = JSON.parse(raw);
    var secret = PropertiesService.getScriptProperties().getProperty('AUTH_MAIL_SECRET');
    if (!/^[a-f0-9]{64}$/.test(secret || '')) return result_(false);
    if (request.version !== 1 || !Number.isSafeInteger(request.timestamp)
        || Math.abs(Date.now() - request.timestamp) > 120000
        || typeof request.verificationId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.verificationId)
        || typeof request.email !== 'string' || request.email.length > 254
        || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(request.email)
        || typeof request.code !== 'string' || !/^\d{6}$/.test(request.code)
        || typeof request.signature !== 'string' || !/^[a-f0-9]{64}$/.test(request.signature)) {
      return result_(false);
    }
    var canonical = JSON.stringify([1, request.verificationId, request.timestamp, request.email, request.code]);
    var signature = hex_(Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8));
    if (!equal_(signature, request.signature)) return result_(false);

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) return result_(false);
    try {
      var props = PropertiesService.getScriptProperties();
      var now = Date.now();
      var all = props.getProperties();
      Object.keys(all).forEach(function (key) {
        if (key.indexOf('signup:') !== 0) return;
        try {
          if (JSON.parse(all[key]).expiresAt <= now) props.deleteProperty(key);
        } catch (_) { props.deleteProperty(key); }
      });
      var key = 'signup:' + request.verificationId;
      var digest = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
        JSON.stringify([request.email, request.code]), Utilities.Charset.UTF_8));
      var previous = props.getProperty(key);
      if (previous) {
        var record = JSON.parse(previous);
        return result_(record.status === 'sent' && record.digest === digest, request.verificationId);
      }
      if (MailApp.getRemainingDailyQuota() < 1) return result_(false);
      var pending = { status: 'pending', digest: digest, expiresAt: now + 15 * 60000 };
      // 발송 전에 예약한다. 결과가 불명확해도 같은 코드를 중복 발송하지 않는다.
      props.setProperty(key, JSON.stringify(pending));
      MailApp.sendEmail({
        to: request.email,
        subject: '[TourLint] 회원가입 이메일 인증코드',
        name: 'TourLint',
        body: 'TourLint 회원가입 인증코드는 ' + request.code + ' 입니다.\n\n'
          + '10분 안에 가입 화면에 입력해 주세요.\n'
          + '이 코드를 다른 사람에게 알려주지 마세요.\n'
          + '직접 요청하지 않았다면 이 메일을 무시하셔도 됩니다.'
      });
      pending.status = 'sent';
      props.setProperty(key, JSON.stringify(pending));
      return result_(true, request.verificationId);
    } finally { lock.releaseLock(); }
  } catch (_) {
    // 주소·코드·키·공급자 오류를 실행 로그나 HTTP 응답에 출력하지 않는다.
    return result_(false);
  }
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ service: 'tourlint-signup-mail' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 최초 설정 때 이 함수를 한 번 실행해 메일 발송 권한을 승인한다. 메일을 발송하지 않는다. */
function authorizeMail() {
  return MailApp.getRemainingDailyQuota();
}

function result_(ok, id) {
  return ContentService.createTextOutput(JSON.stringify(ok ? { ok: true, verificationId: id } : { ok: false }))
    .setMimeType(ContentService.MimeType.JSON);
}
function hex_(bytes) {
  return bytes.map(function (n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
}
function equal_(a, b) {
  if (a.length !== b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
