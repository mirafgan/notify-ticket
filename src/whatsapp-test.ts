import dotenv from 'dotenv';
import { getWhatsAppConfig, launchWhatsAppContext, sendWhatsAppMessage } from './whatsapp';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const config = getWhatsAppConfig();
  if (!config.phone) {
    throw new Error('ADY_WHATSAPP_PHONE .env faylında yazılmayıb.');
  }
  config.enabled = true;

  const context = await launchWhatsAppContext();
  let keepOpen = false;
  try {
    const message = process.env.ADY_WHATSAPP_TEST_MESSAGE || 'ADY monitor WhatsApp testi';
    console.log(`WhatsApp test mesajı göndərilir: ${message}`);

    const result = await sendWhatsAppMessage(context, config, message, {
      keepOpenOnFailure: true,
      keepOpenAfterSend: true,
      onStatus: (statusMessage) => console.log(statusMessage),
    });

    if (!result.sent) {
      keepOpen = Boolean(result.keepOpen);
      throw new Error(result.reason);
    }

    keepOpen = Boolean(result.keepOpen);
    console.log(`WhatsApp test mesajı göndərildi: ${config.phone}`);
  } finally {
    if (keepOpen) {
      console.log('Browser 60 saniyə açıq qalacaq ki, WhatsApp ekranını yoxlaya biləsən.');
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
