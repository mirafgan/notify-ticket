import dotenv from 'dotenv';
import { getWhatsAppConfig, launchWhatsAppContext, sendWhatsAppMessage } from './whatsapp';

dotenv.config({ quiet: true });

function buildSimulatedMessage(): string {
  const from = process.env.ADY_FROM_EXACT || 'BAKI DYV';
  const to = process.env.ADY_TO_EXACT || 'TBİLİSİ-SƏRN';
  const adults = process.env.ADY_ADULTS || '3';
  const price = Number(process.env.ADY_SIMULATED_PRICE || process.env.ADY_MAX_PRICE || 87.72).toFixed(2);
  const date = process.env.ADY_SIMULATED_DATE_LABEL || '03 avq';

  return `TEST: ADY ucuz bilet tapıldı. ${from} -> ${to}, ${date}, ${adults} b. Ən ucuz: ${price} AZN.`;
}

async function main(): Promise<void> {
  const config = getWhatsAppConfig();
  if (!config.phone) {
    throw new Error('ADY_WHATSAPP_PHONE .env faylında yazılmayıb.');
  }
  config.enabled = true;

  const context = await launchWhatsAppContext();
  let keepOpenOnFailure = false;
  let keepOpenAfterSend = false;
  try {
    const message = buildSimulatedMessage();
    console.log(`Simulyasiya mesajı göndərilir: ${message}`);

    const result = await sendWhatsAppMessage(context, config, message, {
      keepOpenOnFailure: true,
      keepOpenAfterSend: true,
      onStatus: (statusMessage) => console.log(statusMessage),
    });

    if (!result.sent) {
      keepOpenOnFailure = Boolean(result.keepOpen);
      throw new Error(result.reason);
    }
    keepOpenAfterSend = Boolean(result.keepOpen);

    console.log(`Simulyasiya WhatsApp mesajı göndərildi: ${config.phone}`);
  } finally {
    if (keepOpenOnFailure) {
      console.log('Browser 60 saniyə açıq qalacaq ki, WhatsApp ekranını yoxlaya biləsən.');
      await new Promise((resolve) => setTimeout(resolve, 60000));
    } else if (keepOpenAfterSend) {
      console.log('Mesaj göndərildi. Browser 30 saniyə açıq qalacaq ki, chatda görə biləsən.');
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
