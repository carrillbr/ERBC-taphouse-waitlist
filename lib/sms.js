// Text messages through Twilio's REST API. With no Twilio credentials the app
// runs in demo mode: messages are logged and saved, but nothing is sent.
const crypto = require('node:crypto');

function smsConfig(env = process.env) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  const service = env.TWILIO_MESSAGING_SERVICE_SID;
  return { sid, token, from, service, enabled: Boolean(sid && token && (from || service)) };
}

async function sendSms(to, body, config = smsConfig()) {
  if (!config.enabled) {
    console.log(`[sms demo] to ${to}: ${body}`);
    return { status: 'demo' };
  }
  const params = new URLSearchParams({ To: to, Body: body });
  if (config.service) params.set('MessagingServiceSid', config.service);
  else params.set('From', config.from);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.sid}:${config.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[sms] Twilio error', res.status, data.message);
    return { status: 'failed', error: data.message || `HTTP ${res.status}` };
  }
  return { status: data.status || 'queued', sid: data.sid };
}

// Check that an inbound webhook really came from Twilio.
// https://www.twilio.com/docs/usage/security#validating-requests
function validTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { smsConfig, sendSms, validTwilioSignature };
