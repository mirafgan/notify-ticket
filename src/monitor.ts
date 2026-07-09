import 'dotenv/config';

import { spawn } from 'node:child_process';
import type { BrowserContext } from 'playwright';
import { getWhatsAppConfig, sendWhatsAppMessage } from './whatsapp';
import {
  buildRequestFromEnv,
  buildRuntimeConfig,
  delay,
  formatPrice,
  launchBrowser,
  runChecks,
  summarizeBatchForMaxPrice,
  type PriceSummaryResult,
} from './modules/ady/scraper';

const once = process.argv.includes('--once');
const stopOnAvailable = parseBoolean(process.env.ADY_STOP_ON_AVAILABLE, true);
const runtimeConfig = buildRuntimeConfig(process.env);
const request = buildRequestFromEnv(process.env);
const whatsapp = getWhatsAppConfig();

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function now(): string {
  return new Date().toLocaleString('az-AZ', { hour12: false });
}

function log(message: string): void {
  console.log(`[${now()}] ${message}`);
}

async function notifyAvailable(context: BrowserContext, result: PriceSummaryResult): Promise<void> {
  const priceText = result.cheapestPrice == null ? '' : ` Ən ucuz: ${formatPrice(result.cheapestPrice)} AZN.`;
  const targetText = result.target ? `${result.target.displayValue}, ` : '';
  const message = `${request.from.exact} -> ${request.to.exact}, ${targetText}${request.adults} b.${priceText}`;
  showWindowsNotification('ADY bilet tapıla bilər', message);
  log(`Windows notification göndərildi.${result.screenshotPath ? ` Screenshot: ${result.screenshotPath}` : ''}`);

  if (whatsapp.enabled) {
    const whatsappResult = await sendWhatsAppMessage(context, whatsapp, message).catch((error: Error) => ({
      sent: false as const,
      reason: error.message,
    }));

    if (whatsappResult.sent) {
      log(`WhatsApp mesajı göndərildi: ${whatsapp.phone}`);
    } else {
      log(`WhatsApp mesajı göndərilmədi: ${whatsappResult.reason}`);
    }
  }
}

function showWindowsNotification(title: string, message: string): void {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = ${toPowerShellString(title)}
$notify.BalloonTipText = ${toPowerShellString(message)}
$notify.Visible = $true
$notify.ShowBalloonTip(10000)
Start-Sleep -Seconds 10
$notify.Dispose()
`;

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const context = await launchBrowser({ ...runtimeConfig, log });
  const page = context.pages()[0] || (await context.newPage());

  try {
    while (true) {
      try {
        const batch = await runChecks(page, request, { ...runtimeConfig, log });
        const result = summarizeBatchForMaxPrice(batch, request, runtimeConfig);

        if (result.status === 'no-match' || result.status === 'price-too-high') {
          log(result.message);
        }

        if (result.status === 'price-ok') {
          await notifyAvailable(context, result);
          if (stopOnAvailable) break;
        }

        if (result.status === 'date-disabled' && runtimeConfig.notifyOnDateDisabled) {
          await notifyAvailable(context, result);
          if (stopOnAvailable) break;
        }
      } catch (error) {
        log(`Xəta: ${getErrorMessage(error)}`);
        if (once) {
          process.exitCode = 1;
          break;
        }
      }

      if (once) break;
      log(`Növbəti yoxlama ${Math.round(runtimeConfig.intervalMs / 1000)} saniyə sonra.`);
      await delay(runtimeConfig.intervalMs);
    }
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
