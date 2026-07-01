const nodemailer = require('nodemailer');
require('dotenv').config();

let transporter = null;

/**
 * Lazy-init the SMTP transporter (only if EMAIL_NOTIFICATIONS_ENABLED).
 */
function getTransporter() {
    if (transporter) return transporter;

    if (process.env.EMAIL_NOTIFICATIONS_ENABLED !== 'true') {
        return null;
    }

    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;

    if (!host || !user || !pass) {
        console.warn('[MAILER] EMAIL_NOTIFICATIONS_ENABLED=true but SMTP_HOST/USER/PASSWORD are missing — email disabled');
        return null;
    }

    transporter = nodemailer.createTransport({
        host,
        port,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user, pass }
    });

    transporter.verify().then(() => {
        console.log('[MAILER] SMTP connection verified OK');
    }).catch(err => {
        console.error('[MAILER] SMTP verify failed:', err.message);
        console.error('[MAILER]   code:', err.code, 'command:', err.command);
        transporter = null; // clear cache so next call retries with fresh .env
    });

    return transporter;
}

/**
 * Send an email notification about state verification mismatches.
 *
 * @param {Array<{userId, userName, displayName, currentState, expectedState, lastScanTime, scanCount}>} mismatches
 * @returns {Promise<boolean>} true if sent, false if skipped/disabled
 */
async function sendMismatchNotification(mismatches) {
    const t = getTransporter();
    if (!t) {
        console.log('[MAILER] Email notifications disabled or misconfigured — skipping');
        return false;
    }

    const to = process.env.VERIFICATION_NOTIFY_EMAIL;
    if (!to) {
        console.warn('[MAILER] VERIFICATION_NOTIFY_EMAIL not set — skipping');
        return false;
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    // Group mismatches by user in a readable format
    const now = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
    const rows = mismatches.map(m => {
        const scanTime = m.lastScanTime
            ? new Date(m.lastScanTime).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })
            : '?';
        return `<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd">${m.displayName} (${m.userName})</td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;color:#c00;font-weight:bold">${m.currentState}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;color:#080;font-weight:bold">${m.expectedState}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd">${m.scanCount}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd">${scanTime}</td>
        </tr>`;
    }).join('');

    const subject = `⚠️ Niezgodność przełącznika — ${mismatches.length} użytkownik(ów) — ${now}`;
    const html = `
        <h2>Wykryto niezgodność przełącznika</h2>
        <p>Czas: <strong>${now}</strong></p>
        <table style="border-collapse:collapse;width:100%;max-width:700px">
            <thead>
                <tr style="background:#f5f5f5">
                    <th style="padding:6px 10px;text-align:left">Użytkownik</th>
                    <th style="padding:6px 10px;text-align:left">Stan przełącznika</th>
                    <th style="padding:6px 10px;text-align:left">Oczekiwany stan (skan)</th>
                    <th style="padding:6px 10px;text-align:left">Skanów</th>
                    <th style="padding:6px 10px;text-align:left">Ostatni skan</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;color:#888;font-size:12px">Wygenerowano automatycznie — TimeTracker</p>
    `;

    try {
        await t.sendMail({ from, to, subject, html });
        console.log(`[MAILER] Mismatch notification sent to ${to} (${mismatches.length} users)`);
        return true;
    } catch (err) {
        console.error(`[MAILER] Failed to send notification: ${err.message}`);
        return false;
    }
}

module.exports = { sendMismatchNotification };
