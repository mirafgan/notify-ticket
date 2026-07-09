import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';

export interface WhatsAppConfig {
  enabled: boolean;
  phone: string;
  waitMs: number;
}

interface SendWhatsAppOptions {
  keepOpenOnFailure?: boolean;
  keepOpenAfterSend?: boolean;
  onStatus?: (message: string) => void;
}

type SendWhatsAppResult =
  | { sent: true; keepOpen: boolean }
  | { sent: false; keepOpen?: boolean; reason: string };

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

export function getWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig {
  const phone = normalizePhone(env.ADY_WHATSAPP_PHONE || '');

  return {
    enabled: parseBoolean(env.ADY_WHATSAPP_ENABLED, Boolean(phone)),
    phone,
    waitMs: Number(env.ADY_WHATSAPP_WAIT_MS || 300000),
  };
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d]/g, '');
}

export async function launchWhatsAppContext(): Promise<BrowserContext> {
  const userDataDir = path.resolve(process.cwd(), process.env.ADY_WHATSAPP_PROFILE_DIR || '.whatsapp-profile');
  await fs.mkdir(userDataDir, { recursive: true });

  return chromium.launchPersistentContext(userDataDir, {
    headless: parseBoolean(process.env.ADY_HEADLESS, false),
    viewport: { width: 1365, height: 768 },
    locale: 'az-AZ',
    timezoneId: 'Asia/Baku',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export async function sendWhatsAppMessage(
  context: BrowserContext,
  config: WhatsAppConfig,
  message: string,
  options: SendWhatsAppOptions = {},
): Promise<SendWhatsAppResult> {
  if (!config.enabled || !config.phone) {
    return { sent: false, reason: 'WhatsApp deaktivdir və ya nömrə yazılmayıb.' };
  }

  const onStatus = options.onStatus ?? (() => {});
  const page = await context.newPage();
  let shouldClosePage = true;
  try {
    const url = `https://web.whatsapp.com/send?phone=${config.phone}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.waitMs });

    const qrCanvas = page.locator('canvas').first();
    const chatInput = messageBox(page);

    await Promise.race([
      chatInput.waitFor({ state: 'visible', timeout: config.waitMs }),
      qrCanvas.waitFor({ state: 'visible', timeout: config.waitMs }),
    ]);

    if ((await qrCanvas.count()) > 0 && (await qrCanvas.isVisible().catch(() => false))) {
      onStatus('QR kod göründü. Telefonla skan et, browser açıq qalacaq.');
      try {
        await chatInput.waitFor({ state: 'visible', timeout: config.waitMs });
      } catch {
        shouldClosePage = !options.keepOpenOnFailure;
        return {
          sent: false,
          keepOpen: options.keepOpenOnFailure,
          reason: `WhatsApp Web login ${Math.round(config.waitMs / 1000)} saniyə ərzində tamamlanmadı.`,
        };
      }
    }

    await chatInput.waitFor({ state: 'visible', timeout: config.waitMs });
    const wroteMessage = await writeMessage(page, chatInput, message);
    if (!wroteMessage) {
      shouldClosePage = !options.keepOpenOnFailure;
      return {
        sent: false,
        keepOpen: options.keepOpenOnFailure,
        reason: 'Mesaj WhatsApp inputuna yazılmadı.',
      };
    }

    const clicked = await clickSendButton(page);
    if (!clicked) {
      await chatInput.press('Enter').catch(() => {});
    }

    const confirmed = await waitUntilMessageLeavesInput(page, message, 15000);
    if (!confirmed) {
      shouldClosePage = !options.keepOpenOnFailure;
      return {
        sent: false,
        keepOpen: options.keepOpenOnFailure,
        reason: 'Mesaj inputda qaldı; WhatsApp send düyməsi basılmadı və mesaj göndərilmədi.',
      };
    }

    if (options.keepOpenAfterSend) {
      shouldClosePage = false;
    }

    await page.waitForTimeout(1500);
    return { sent: true, keepOpen: Boolean(options.keepOpenAfterSend) };
  } finally {
    if (shouldClosePage) {
      await page.close().catch(() => {});
    }
  }
}

function messageBox(page: Page): Locator {
  return page
    .locator(
      [
        'footer [contenteditable="true"][role="textbox"]',
        'footer [contenteditable="true"][data-tab]',
        'div[aria-label="Type a message"][contenteditable="true"]',
        'div[aria-placeholder="Type a message"][contenteditable="true"]',
        'div[aria-label="Mesaj yazın"][contenteditable="true"]',
        'div[aria-placeholder="Mesaj yazın"][contenteditable="true"]',
      ].join(', '),
    )
    .last();
}

async function writeMessage(page: Page, chatInput: Locator, message: string): Promise<boolean> {
  await chatInput.click();
  await clearMessageInput(page, chatInput);

  await chatInput.fill(message).catch(() => {});
  if (await messageIsInInput(page, message)) return true;

  await chatInput.click();
  await page.keyboard.type(message, { delay: 5 }).catch(() => {});
  if (await messageIsInInput(page, message)) return true;

  await chatInput.evaluate((element, text) => {
    element.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, text);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }, message).catch(() => {});

  return messageIsInInput(page, message);
}

async function clearMessageInput(page: Page, chatInput: Locator): Promise<void> {
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});

  const stillHasText = await chatInput
    .evaluate((element) => Boolean(((element as HTMLElement).innerText || element.textContent || '').trim()))
    .catch(() => false);

  if (stillHasText) {
    await chatInput.evaluate((element) => {
      element.textContent = '';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }).catch(() => {});
  }
}

async function clickSendButton(page: Page): Promise<boolean> {
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const selectors = [
      'footer button[aria-label="Send"]',
      'footer button[aria-label="Göndər"]',
      'footer button[aria-label="Gönder"]',
      'footer span[data-icon="send"]',
      'footer span[data-icon="wds-ic-send-filled"]',
      'footer [data-testid="send"]',
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      const target = element.closest('button,[role="button"]') || element;
      (target as HTMLElement).click();
      return true;
    }

    return false;
  });
}

async function waitUntilMessageLeavesInput(page: Page, message: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (expectedMessage: string) => {
        const boxes = [
          ...document.querySelectorAll(
            [
              'footer [contenteditable="true"][role="textbox"]',
              'footer [contenteditable="true"][data-tab]',
              'div[aria-label="Type a message"][contenteditable="true"]',
              'div[aria-placeholder="Type a message"][contenteditable="true"]',
              'div[aria-label="Mesaj yazın"][contenteditable="true"]',
              'div[aria-placeholder="Mesaj yazın"][contenteditable="true"]',
            ].join(', '),
          ),
        ];
        const box = boxes[boxes.length - 1];
        if (!box) return false;

        const boxText = ((box as HTMLElement).innerText || box.textContent || '').replace(/\s+/g, ' ').trim();
        const visibleSentText = [...document.querySelectorAll('div.message-out, [data-testid="msg-container"]')]
          .some((element) => ((element as HTMLElement).innerText || element.textContent || '').includes(expectedMessage));
        const main = document.querySelector('#main') || document.body;
        const footer = document.querySelector('footer');
        const footerText = footer ? ((footer as HTMLElement).innerText || footer.textContent || '') : '';
        const mainText = ((main as HTMLElement).innerText || main.textContent || '').replace(footerText, '');
        const visibleInChat = mainText.includes(expectedMessage);

        return visibleSentText || (boxText === '' && visibleInChat);
      },
      message,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

async function messageIsInInput(page: Page, message: string): Promise<boolean> {
  return page
    .waitForFunction(
      (expectedMessage: string) => {
        const boxes = [
          ...document.querySelectorAll(
            [
              'footer [contenteditable="true"][role="textbox"]',
              'footer [contenteditable="true"][data-tab]',
              'div[aria-label="Type a message"][contenteditable="true"]',
              'div[aria-placeholder="Type a message"][contenteditable="true"]',
              'div[aria-label="Mesaj yazın"][contenteditable="true"]',
              'div[aria-placeholder="Mesaj yazın"][contenteditable="true"]',
            ].join(', '),
          ),
        ];
        const box = boxes[boxes.length - 1];
        if (!box) return false;

        const value = ((box as HTMLElement).innerText || box.textContent || '').replace(/\s+/g, ' ').trim();
        return value.includes(expectedMessage);
      },
      message,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
}
