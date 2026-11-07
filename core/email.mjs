import { formatGHS, SERVICE_BY_ID } from "./pricing.mjs";

const DEFAULT_ENDPOINT = "https://api.resend.com/emails";
const WARNING = "Your booking is confirmed, but the receipt email could not be sent. Keep your tracking code.";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function bookingReceipt(shipment, trackingUrl) {
  const code = String(shipment.code);
  const name = String(shipment.customer?.name || "traveller");
  const from = String(shipment.from?.name || "your pickup point");
  const to = String(shipment.to?.name || "your destination");
  const pieces = Number(shipment.logistics?.pieces) || 0;
  const weight = Number(shipment.logistics?.weightKg) || 0;
  const service = SERVICE_BY_ID[shipment.logistics?.service]?.label || String(shipment.logistics?.service || "Standard");
  const date = String(shipment.pickup?.date || "");
  const window = String(shipment.pickup?.window || "");
  const total = formatGHS(Number(shipment.total ?? shipment.price?.total) || 0);
  const payment = "No payment now — pay the driver or arrange WhatsApp Mobile Money at collection.";
  const subject = `BrownHub Haul ${code} — booking confirmed`;
  const text = [
    "BrownHub Haul — an app of BrownHub Studio",
    `Booking ${code} confirmed`,
    "",
    `Hello ${name},`,
    `Route: ${from} → ${to}`,
    `Luggage: ${pieces} piece(s), ${weight} kg`,
    `Service: ${service}`,
    `Collection: ${date} · ${window}`,
    `Total: ${total}`,
    "",
    `Track your haul: ${trackingUrl}`,
    payment,
    "Your private handover PIN is shown only on the booking confirmation screen and is not included in this email.",
  ].join("\n");
  const rows = [
    ["Route", `${from} → ${to}`],
    ["Luggage", `${pieces} piece(s), ${weight} kg`],
    ["Service", service],
    ["Collection", `${date} · ${window}`],
    ["Total", total],
  ]
    .map(([label, value]) => `<tr><th align="left" style="padding:10px 14px 10px 0;color:#6e5248;font-size:13px;font-weight:600;vertical-align:top">${escapeHtml(label)}</th><td style="padding:10px 0;color:#26100f;font-size:14px">${escapeHtml(value)}</td></tr>`)
    .join("");
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#fffbf7;color:#26100f;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:620px;margin:0 auto;padding:28px 18px">
  <div style="padding:26px 26px 24px;border-radius:18px 18px 0 0;background:#26100f;color:#fffbf7">
    <p style="margin:0 0 10px;color:#d9b98c;font-size:11px;letter-spacing:.16em;text-transform:uppercase">An app of BrownHub Studio</p>
    <h1 style="margin:0 0 8px;font-size:28px;font-weight:600">BrownHub Haul</h1>
    <p style="margin:0;color:#f2e4d6;font-size:14px">Booking <strong style="color:#fff">${escapeHtml(code)}</strong> confirmed</p>
  </div>
  <div style="padding:26px;border:1px solid #e9d6c6;border-top:0;border-radius:0 0 18px 18px;background:#fff">
    <p style="margin:0 0 12px;font-size:16px">Hello ${escapeHtml(name)},</p>
    <p style="margin:0 0 18px;color:#6e5248;font-size:14px;line-height:1.6">Your luggage collection is on the manifest. Keep this receipt and follow the journey with your tracking code.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #e9d6c6;border-bottom:1px solid #e9d6c6">${rows}</table>
    <p style="margin:24px 0"><a href="${escapeHtml(trackingUrl)}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:#ca2b30;color:#fff;font-size:14px;font-weight:700;text-decoration:none">Track your haul</a></p>
    <p style="margin:0 0 12px;color:#6e5248;font-size:13px;line-height:1.6">${escapeHtml(payment)}</p>
    <p style="margin:0;color:#8c6333;font-size:12px;line-height:1.6">Your private handover PIN is shown only on the booking confirmation screen and is not included in this email.</p>
  </div>
  <p style="margin:16px 4px 0;color:#6e5248;font-size:12px">BrownHub Studio · Accra, Ghana</p>
</div></body></html>`;
  return { subject, text, html };
}

export function createBookingMailer({ apiKey = "", from = "", fetchImpl = fetch, endpoint = DEFAULT_ENDPOINT, timeoutMs = 8000 } = {}) {
  return {
    async sendReceipt(shipment, trackingUrl) {
      const email = String(shipment.customer?.email || "").trim();
      if (!email) return { attempted: false, delivered: false, message: "Add an email address next time to receive a receipt." };
      if (!apiKey || !from) return { attempted: true, delivered: false, message: WARNING };
      try {
        const receipt = bookingReceipt(shipment, trackingUrl);
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [email], ...receipt }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const ok = res.ok;
        await res.body?.cancel?.();
        if (!ok) return { attempted: true, delivered: false, message: WARNING };
        return { attempted: true, delivered: true, message: `Receipt sent to ${email}.` };
      } catch {
        return { attempted: true, delivered: false, message: WARNING };
      }
    },
  };
}