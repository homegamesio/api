// Transactional email via AWS SES (aws-sdk v2 — already a project dependency).
//
// Used for developer-signup email verification. We email a short numeric CODE
// (not a clickable link) so that email-client link prefetching can't silently
// consume the verification. The user types the code into the studio, which
// verifies it against their authenticated session.
//
// When SES_FROM_ADDRESS is unset (local/dev), sending is skipped and the code
// is logged instead, so signup still works without SES configured. In
// production, SES_FROM_ADDRESS must be a verified SES identity and the account
// must be out of the SES sandbox.

const { SES_REGION, SES_FROM_ADDRESS } = require('./config');

const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sendVerificationEmail = (toEmail, displayName, code) => new Promise((resolve, reject) => {
    if (!SES_FROM_ADDRESS) {
        console.warn(`[email] SES_FROM_ADDRESS not set — skipping verification email. Code for ${toEmail}: ${code}`);
        resolve({ skipped: true });
        return;
    }

    const aws = require('aws-sdk');
    const ses = new aws.SES({ region: SES_REGION });

    const name = displayName || 'there';
    const text =
        `Hi ${name},\n\n` +
        `Your Homegames verification code is: ${code}\n\n` +
        `Enter it in the studio to finish setting up your developer account. ` +
        `It expires in 24 hours. If you didn't sign up, you can ignore this email.`;
    const html =
        `<p>Hi ${escapeHtml(name)},</p>` +
        `<p>Your Homegames verification code is:</p>` +
        `<p style="font-size:22px;font-weight:bold;letter-spacing:3px;">${escapeHtml(code)}</p>` +
        `<p>Enter it in the studio to finish setting up your developer account. It expires in 24 hours. ` +
        `If you didn't sign up, you can ignore this email.</p>`;

    ses.sendEmail({
        Source: SES_FROM_ADDRESS,
        Destination: { ToAddresses: [toEmail] },
        Message: {
            Subject: { Data: 'Your Homegames verification code' },
            Body: { Text: { Data: text }, Html: { Data: html } },
        },
    }, (err, data) => {
        if (err) reject(err); else resolve(data);
    });
});

const sendPasswordResetEmail = (toEmail, displayName, code) => new Promise((resolve, reject) => {
    if (!SES_FROM_ADDRESS) {
        console.warn(`[email] SES_FROM_ADDRESS not set — skipping password reset email. Code for ${toEmail}: ${code}`);
        resolve({ skipped: true });
        return;
    }

    const aws = require('aws-sdk');
    const ses = new aws.SES({ region: SES_REGION });

    const name = displayName || 'there';
    const text =
        `Hi ${name},\n\n` +
        `Your Homegames password reset code is: ${code}\n\n` +
        `Enter it on the reset page to set a new password. It expires in 1 hour. ` +
        `If you didn't request this, you can ignore this email — your password is unchanged.`;
    const html =
        `<p>Hi ${escapeHtml(name)},</p>` +
        `<p>Your Homegames password reset code is:</p>` +
        `<p style="font-size:22px;font-weight:bold;letter-spacing:3px;">${escapeHtml(code)}</p>` +
        `<p>Enter it on the reset page to set a new password. It expires in 1 hour. ` +
        `If you didn't request this, you can ignore this email — your password is unchanged.</p>`;

    ses.sendEmail({
        Source: SES_FROM_ADDRESS,
        Destination: { ToAddresses: [toEmail] },
        Message: {
            Subject: { Data: 'Your Homegames password reset code' },
            Body: { Text: { Data: text }, Html: { Data: html } },
        },
    }, (err, data) => {
        if (err) reject(err); else resolve(data);
    });
});

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
