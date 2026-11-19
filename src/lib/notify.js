'use strict';
// Optional webhook (a chat incoming webhook): "New application for <role>: <link>".
// The text never contains anything about the applicant. Failures are logged by application id only and
// never reach the applicant.
const TIMEOUT_MS = 3000;

async function notifyNewApplication({ webhookUrl, fetchImpl, log, roleTitle, applicationId, baseUrl }) {
  if (!webhookUrl) return false;
  const text = `New application for ${roleTitle}: ${baseUrl}/app/applications/${applicationId}`;
  try {
    const res = await (fetchImpl || globalThis.fetch)(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error('non-2xx');
    return true;
  } catch {
    log(`[webhook] failed application=${applicationId}`);
    return false;
  }
}

module.exports = { notifyNewApplication, TIMEOUT_MS };
