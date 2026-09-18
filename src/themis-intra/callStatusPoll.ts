import { config } from "../config.js";
import { updateCallBySid } from "../supabase.js";
import { scheduleThemisRetryIfNeeded, THEMIS_NOT_PICKED_UP_STATUSES } from "./retry.js";
import {
  renderThemisPostCallSmsBody,
  sendThemisPostCallSms,
  THEMIS_POST_CALL_SMS_TEMPLATE,
  resolveThemisSmsProvider,
  resolveThemisSmsSender,
} from "../services/themisPostCallSms.js";
import { hasSmsMessageForCallTemplate, insertSmsMessage, updateSmsMessageById } from "../services/twilioSms.js";

/**
 * Auto-poll: repeatedly check a Themis campaign call's Twilio status until terminal,
 * then persist the terminal status to the calls table, send the post-call SMS (guarded,
 * exactly once) and schedule a retry if the call was not picked up.
 *
 * History:
 *   Fix 2026-07-06: bypasses Twilio webhook not-working issue.
 *   Fix 2026-07-08: repeated polling — handles calls that last >75s.
 *   Area B 2026-09-14: 8 × 60s (was 6 × 30s = 3 min, could miss long calls).
 *   5331 fix 2026-09-18: moved verbatim out of routes/themis-intra.ts (start_calls_campaign_api
 *     background loop) into this module so that RETRY-dialed calls (processDueThemisRetries →
 *     startOutboundCall) get the IDENTICAL status write-back wiring as attempt-1 calls.
 *     Root cause of attempt-2 rows stuck at status='initiated' (e.g. call 36e1cc1e /
 *     CA5f88558e, 2026-09-17 15:58Z): the retry path registered no poll, and the Twilio
 *     StatusCallback never fires (error 21626 on every call), so nothing ever wrote the
 *     terminal status → no post-call SMS, no attempt-3 scheduling, Intra shows "unknown".
 *
 * Fire-and-forget: schedules timers and returns immediately.
 */
export function startThemisCallStatusAutoPoll(params: {
  callId: string;
  twilioCallSid: string;
  phone: string;
  debtAmountRaw: unknown;
}): void {
  const { callId, twilioCallSid, phone, debtAmountRaw } = params;
  const maxPolls = 8;       // 8 × 60s = 8 minutes total (Area B 2026-09-14: was 6 × 30s = 3 min, could miss long calls)
  let pollCount = 0;

  async function pollCallStatus(): Promise<void> {
    pollCount += 1;
    try {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${twilioCallSid}.json`;
      const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
      const resp = await fetch(twilioUrl, { headers: { Authorization: `Basic ${auth}` } });
      if (!resp.ok) {
        if (pollCount < maxPolls) {
          setTimeout(pollCallStatus, 30_000);
        }
        return;
      }
      const data = await resp.json();

      const endedStatuses = new Set(["completed", "busy", "no-answer", "canceled", "failed"]);
      if (!endedStatuses.has(data.status)) {
        // Call still in progress — poll again if we haven't hit the limit
        if (pollCount < maxPolls) {
          setTimeout(pollCallStatus, 60_000);
        }
        return;
      }

      // --- Call has ended (terminal status) ---
      const recipient = data.to || phone;
      const debtAmount = String(debtAmountRaw || "").trim() || "0";

      // Update the calls table so the safety net (scheduleMissedRetries)
      // can detect missed retries even if the Twilio webhook doesn't fire.
      await updateCallBySid(twilioCallSid, {
        status: data.status,
        ended_at: data.endTime ? new Date(data.endTime).toISOString() : new Date().toISOString(),
        duration_seconds: data.duration ? parseInt(String(data.duration), 10) : null,
      }).catch((err: unknown) =>
        console.warn(`[ThemisAuto] updateCallBySid error:`, err)
      );

      if (debtAmount) {
        // G fix 2026-09-17 (5331): unify the auto-poll path with the webhook +
        // media-stream finalizer senders. Root cause of SMS#1/SMS#2: this path sent
        // directly with no sms_messages marker and no idempotency check, so a call
        // terminated by BOTH the finalizer and auto-poll produced two identical SMS.
        // Same contract as twilio-webhooks.ts + media-stream.ts:
        //   guard (hasSmsMessageForCallTemplate) → marker insert (backstopped by
        //   unique index uq_sms_messages_themis_post_call) → send → marker update.
        const alreadySent = await hasSmsMessageForCallTemplate(callId, THEMIS_POST_CALL_SMS_TEMPLATE);
        if (alreadySent === null) {
          console.warn(`[ThemisAutoSMS] skip: idempotency check unavailable callId=${callId} callSid=${twilioCallSid}`);
        } else if (alreadySent) {
          console.log(`[ThemisAutoSMS] skip: already sent callId=${callId} callSid=${twilioCallSid}`);
        } else {
          const smsBody = renderThemisPostCallSmsBody(debtAmount);
          const provider = resolveThemisSmsProvider();
          const sender = resolveThemisSmsSender(provider);
          const smsRowId = await insertSmsMessage({
            call_id: callId,
            agent_id: null,
            template_name: THEMIS_POST_CALL_SMS_TEMPLATE,
            direction: "outbound",
            from_number: sender,
            to_number: recipient,
            body: smsBody,
            twilio_sid: null,
            status: "queued",
            ...(provider === "messente" ? { provider, sender_name: sender } : {}),
          });
          if (!smsRowId) {
            console.warn(`[ThemisAutoSMS] skip: failed to persist SMS marker callId=${callId} callSid=${twilioCallSid}`);
          } else {
            const smsResult = await sendThemisPostCallSms({ to: recipient, body: smsBody });
            if (smsResult.ok) {
              const patch: Record<string, unknown> = { status: smsResult.status || "sent" };
              if (smsResult.provider === "messente") {
                patch.provider = "messente";
                patch.provider_message_id = smsResult.providerMessageId || null;
              } else {
                patch.twilio_sid = smsResult.providerMessageId || null;
              }
              await updateSmsMessageById(smsRowId, patch);
              console.log(`[ThemisAutoSMS] sent via ${smsResult.provider} to ${recipient} for ${twilioCallSid}`);
            } else {
              await updateSmsMessageById(smsRowId, {
                status: `failed:${smsResult.errorCode || "send"}`,
              });
              console.warn(`[ThemisAutoSMS] FAILED ${twilioCallSid}: ${smsResult.error}`);
            }
          }
        }
      }

      // Schedule retry if call was not picked up
      if (THEMIS_NOT_PICKED_UP_STATUSES.has(data.status)) {
        const retryResult = await scheduleThemisRetryIfNeeded({
          callId,
          reason: `auto_poll_${data.status}`,
        });
        if (retryResult.scheduled) {
          console.log(`[ThemisAuto] retry scheduled for callId=${callId}`);
        }
      }
    } catch (err) {
      console.error(`[ThemisAutoSMS] error:`, err);
      if (pollCount < maxPolls) {
        setTimeout(pollCallStatus, 60_000);
      }
    }
  }

  // Start first poll after initial delay (75s)
  setTimeout(pollCallStatus, 75_000);
}
