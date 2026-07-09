import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { AdyStation } from './stations';

const SOLD_OUT_TEXT = 'Bütün biletlər satılıb';
const CONTINUE_TEXT = 'Davam et';

export const AZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avqust',
  'sentyabr',
  'oktyabr',
  'noyabr',
  'dekabr',
] as const;

export const AZ_MONTH_SHORT = [
  'yan',
  'fev',
  'mar',
  'apr',
  'may',
  'iyn',
  'iyl',
  'avq',
  'sen',
  'okt',
  'noy',
  'dek',
] as const;

export type LogFn = (message: string) => void;

export interface RuntimeConfig {
  url: string;
  intervalMs: number;
  resultWaitMs: number;
  headless: boolean;
  notifyOnDateDisabled: boolean;
  browserChannel: string;
  browserProfileDir: string;
  screenshotsEnabled: boolean;
  artifactsDir: string;
  log?: LogFn;
}

export interface TargetDate {
  iso: string;
  year: string;
  month: string;
  day: string;
  monthLabel: string;
  shortMonthLabel: string;
  displayValue: string;
}

export interface NormalizedStation {
  id: string;
  exact: string;
  query: string;
  label: string;
  country: string;
}

export interface AdyRequest {
  from: NormalizedStation;
  to: NormalizedStation;
  targetDates: TargetDate[];
  adults: number;
  maxPrice: number;
}

export type StationInput = string | Partial<AdyStation> & {
  value?: string;
};

export interface AdyRequestInput {
  from?: StationInput;
  to?: StationInput;
  fromExact?: string;
  fromQuery?: string;
  toExact?: string;
  toQuery?: string;
  targetDates?: string | Array<string | TargetDate>;
  targetDatesText?: string;
  targetDate?: string;
  adults?: number | string;
  maxPrice?: number | string;
}

export type DateSkippedStatus = 'date-not-loaded' | 'date-not-found' | 'date-disabled';
export type CheckStatus = DateSkippedStatus | 'sold-out' | 'unknown' | 'tickets-found';
export type SummaryStatus = 'price-ok' | 'price-too-high' | 'date-disabled' | 'no-match';

export interface BaseCheckResult {
  ok: boolean;
  target: TargetDate;
  status: Exclude<CheckStatus, 'tickets-found'>;
  message: string;
  screenshotPath?: string | null;
}

export interface TicketsFoundResult {
  ok: true;
  target: TargetDate;
  status: 'tickets-found';
  message: string;
  cheapestPrice: number;
  prices: number[];
  screenshotPath?: string | null;
}

export interface PriceSummaryResult {
  ok: boolean;
  status: SummaryStatus;
  message: string;
  target?: TargetDate;
  results?: CheckResult[];
  cheapestPrice?: number;
  prices?: number[];
  screenshotPath?: string | null;
}

export type CheckResult = BaseCheckResult | TicketsFoundResult;

export interface CheckBatch {
  ok: true;
  status: 'checked';
  request: AdyRequest;
  results: CheckResult[];
}

interface RunChecksOptions {
  stopWhen?: (result: CheckResult, results: CheckResult[]) => boolean;
}

interface SearchOutcome {
  status: 'tickets-found';
  cheapestPrice: number;
  prices: number[];
}

type DateSelectionResult =
  | { ok: true; status: 'date-selected'; message: string }
  | { ok: false; status: DateSkippedStatus; message: string };

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function numberFromEnv(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    url: env.ADY_URL || 'https://ticket.ady.az/',
    intervalMs: numberFromEnv(env.ADY_INTERVAL_MS, 5 * 60 * 1000),
    resultWaitMs: numberFromEnv(env.ADY_RESULT_WAIT_MS, 90 * 1000),
    headless: parseBoolean(env.ADY_HEADLESS, false),
    notifyOnDateDisabled: parseBoolean(env.ADY_NOTIFY_ON_DATE_DISABLED, false),
    browserChannel: env.ADY_BROWSER_CHANNEL || '',
    browserProfileDir: env.ADY_BROWSER_PROFILE_DIR || '.browser-profile',
    screenshotsEnabled: parseBoolean(env.ADY_SCREENSHOTS_ENABLED, true),
    artifactsDir: env.ADY_ARTIFACTS_DIR || 'artifacts',
    ...overrides,
  };
}

export function buildRequestFromEnv(env: NodeJS.ProcessEnv = process.env): AdyRequest {
  return normalizeRequest({
    from: {
      exact: env.ADY_FROM_EXACT || 'BAKI DYV',
      query: env.ADY_FROM_QUERY || 'BAKI',
    },
    to: {
      exact: env.ADY_TO_EXACT || 'TBİLİSİ-SƏRN',
      query: env.ADY_TO_QUERY || 'TBİLİSİ',
    },
    targetDates: env.ADY_TARGET_DATES || env.ADY_TARGET_DATE || '2026-08-01,2026-08-02,2026-08-03,2026-08-04',
    adults: numberFromEnv(env.ADY_ADULTS, 3),
    maxPrice: numberFromEnv(env.ADY_MAX_PRICE, 87.72),
  });
}

export function normalizeRequest(input: AdyRequestInput | AdyRequest): AdyRequest {
  const from = normalizeStation(input.from ?? {
    exact: 'fromExact' in input ? input.fromExact : undefined,
    query: 'fromQuery' in input ? input.fromQuery : undefined,
  });
  const to = normalizeStation(input.to ?? {
    exact: 'toExact' in input ? input.toExact : undefined,
    query: 'toQuery' in input ? input.toQuery : undefined,
  });
  const targetDates = normalizeTargetDates(input);
  const adults = Number(input.adults);
  const maxPrice = Number(input.maxPrice);

  if (!from.exact || !to.exact) {
    throw new Error('Haradan və haraya stansiyaları yazılmalıdır.');
  }

  if (!Number.isInteger(adults) || adults < 1) {
    throw new Error('Sərnişin sayı müsbət tam ədəd olmalıdır.');
  }

  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    throw new Error('Maksimum qiymət müsbət rəqəm olmalıdır.');
  }

  if (targetDates.length === 0) {
    throw new Error('Ən azı bir tarix seçilməlidir.');
  }

  return {
    from,
    to,
    targetDates,
    adults,
    maxPrice,
  };
}

function normalizeTargetDates(input: AdyRequestInput | AdyRequest): TargetDate[] {
  if (Array.isArray(input.targetDates)) {
    return input.targetDates.map((target) => typeof target === 'string' ? parseTargetDate(target) : target);
  }

  const targetDatesText = 'targetDatesText' in input ? input.targetDatesText : undefined;
  const targetDate = 'targetDate' in input ? input.targetDate : undefined;
  return parseTargetDates(input.targetDates ?? targetDatesText ?? targetDate ?? '');
}

function normalizeStation(station: StationInput | undefined): NormalizedStation {
  if (typeof station === 'string') {
    return {
      id: station,
      exact: station,
      query: station,
      label: station,
      country: '',
    };
  }

  const exact = station?.exact || station?.label || station?.value || '';
  return {
    id: station?.id || exact,
    exact,
    query: station?.query || exact,
    label: station?.label || exact,
    country: station?.country || '',
  };
}

export function parseTargetDate(dateText: string): TargetDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  if (!match) {
    throw new Error(`Tarix YYYY-MM-DD formatında olmalıdır. Gələn dəyər: ${dateText}`);
  }

  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error(`Tarixin ayında xəta var: ${dateText}`);
  }

  const monthLabel = AZ_MONTHS[monthIndex];
  const shortMonthLabel = AZ_MONTH_SHORT[monthIndex];
  return {
    iso: `${match[1]}-${match[2]}-${match[3]}`,
    year: match[1],
    month: match[2],
    day: match[3],
    monthLabel,
    shortMonthLabel,
    displayValue: `${match[3]} ${shortMonthLabel}`,
  };
}

export function parseTargetDates(value: string): TargetDate[] {
  const dates = value
    .split(',')
    .map((date) => date.trim())
    .filter(Boolean);

  if (dates.length === 0) {
    throw new Error('ADY_TARGET_DATES ən azı bir tarix saxlamalıdır.');
  }

  return dates.map(parseTargetDate);
}

export function createScrapeKey(input: AdyRequestInput | AdyRequest): string {
  const request = normalizeRequest(input);
  const dates = request.targetDates.map((target) => target.iso).sort();

  return JSON.stringify({
    service: 'ady.az',
    from: request.from.exact,
    to: request.to.exact,
    dates,
    adults: request.adults,
  });
}

function now(): string {
  return new Date().toLocaleString('az-AZ', { hour12: false });
}

function defaultLog(message: string): void {
  console.log(`[${now()}] ${message}`);
}

export async function launchBrowser(runtimeConfigInput: Partial<RuntimeConfig> = {}): Promise<BrowserContext> {
  const runtimeConfig = buildRuntimeConfig(process.env, runtimeConfigInput);
  const userDataDir = path.resolve(process.cwd(), runtimeConfig.browserProfileDir);
  await fs.mkdir(userDataDir, { recursive: true });

  const baseOptions = {
    headless: runtimeConfig.headless,
    viewport: { width: 1365, height: 768 },
    locale: 'az-AZ',
    timezoneId: 'Asia/Baku',
    args: ['--disable-blink-features=AutomationControlled'],
  };

  const channels = runtimeConfig.browserChannel
    ? [runtimeConfig.browserChannel]
    : ['chrome', 'msedge', ''];

  let lastError: unknown;
  for (const channel of channels) {
    try {
      const options = channel ? { ...baseOptions, channel } : baseOptions;
      const context = await chromium.launchPersistentContext(userDataDir, options);
      const log = runtimeConfig.log ?? defaultLog;
      log(`Browser açıldı${channel ? ` (${channel})` : ''}.`);
      return context;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function runChecks(
  page: Page,
  requestInput: AdyRequestInput | AdyRequest,
  runtimeConfigInput: Partial<RuntimeConfig> = {},
  options: RunChecksOptions = {},
): Promise<CheckBatch> {
  const runtimeConfig = buildRuntimeConfig(process.env, runtimeConfigInput);
  const request = normalizeRequest(requestInput);
  const log = runtimeConfig.log ?? defaultLog;
  const results: CheckResult[] = [];

  for (const target of request.targetDates) {
    const result = await runCheck(page, request, target, runtimeConfig);
    log(result.message);
    results.push(result);

    if (options.stopWhen?.(result, results)) {
      break;
    }
  }

  return {
    ok: true,
    status: 'checked',
    request,
    results,
  };
}

export function summarizeBatchForMaxPrice(
  batch: CheckBatch,
  requestInput: AdyRequestInput | AdyRequest,
  runtimeConfigInput: Partial<RuntimeConfig> = {},
): PriceSummaryResult {
  const runtimeConfig = buildRuntimeConfig(process.env, runtimeConfigInput);
  const request = normalizeRequest(requestInput);
  let cheapestTooHigh: TicketsFoundResult | null = null;

  for (const result of batch.results) {
    if (result.status === 'tickets-found' && result.cheapestPrice <= request.maxPrice) {
      return {
        ...result,
        status: 'price-ok',
        message: `${result.target.displayValue}: Uyğun bilet tapıla bilər: ən ucuz qiymət ${formatPrice(result.cheapestPrice)} AZN.`,
      };
    }

    if (result.status === 'tickets-found') {
      if (!cheapestTooHigh || result.cheapestPrice < cheapestTooHigh.cheapestPrice) {
        cheapestTooHigh = result;
      }
    }

    if (result.status === 'date-disabled' && runtimeConfig.notifyOnDateDisabled) {
      return {
        ...result,
        status: 'date-disabled',
      };
    }
  }

  if (cheapestTooHigh) {
    return {
      ...cheapestTooHigh,
      status: 'price-too-high',
      message: `${cheapestTooHigh.target.displayValue}: Ən ucuz qiymət ${formatPrice(cheapestTooHigh.cheapestPrice)} AZN-dir; limit ${formatPrice(request.maxPrice)} AZN. Notification göndərilmir.`,
    };
  }

  return {
    ok: true,
    status: 'no-match',
    results: batch.results,
    message: `${request.targetDates.map((target) => target.displayValue).join(', ')} tarixlərində ${formatPrice(request.maxPrice)} AZN və ya daha ucuz bilet tapılmadı.`,
  };
}

async function runCheck(
  page: Page,
  request: AdyRequest,
  target: TargetDate,
  runtimeConfig: RuntimeConfig,
): Promise<CheckResult> {
  const log = runtimeConfig.log ?? defaultLog;
  log(`Yoxlama başlayır: ${request.from.exact} -> ${request.to.exact}, ${target.displayValue}, ${request.adults} b.`);

  await waitForHomeReady(page, runtimeConfig);
  await closeOpenPopups(page);

  await selectStation(page, 'form.search__wrapper .form-group--to', request.from.query, request.from.exact);
  await selectStation(page, 'form.search__wrapper .form-group--from', request.to.query, request.to.exact);

  const dateResult = await selectTargetDate(page, target);
  if (!dateResult.ok) {
    return { ...dateResult, target, message: `${target.displayValue}: ${dateResult.message}` };
  }
  log(dateResult.message);

  await setAdults(page, request.adults);

  const result = await submitSearch(page, runtimeConfig);
  if (result === 'sold-out') {
    return { ok: true, target, status: 'sold-out', message: `${target.displayValue}: "${SOLD_OUT_TEXT}" modalı göründü.` };
  }

  if (result === 'unknown') {
    const screenshotPath = await saveScreenshot(page, 'unknown', runtimeConfig);
    return {
      ok: false,
      target,
      status: 'unknown',
      message: `${target.displayValue}: Nəticə ${Math.round(runtimeConfig.resultWaitMs / 1000)} saniyəyə tam bilinmədi; notification göndərilmir.`,
      screenshotPath,
    };
  }

  const screenshotPath = await saveScreenshot(page, 'available', runtimeConfig);
  return {
    ok: true,
    target,
    status: 'tickets-found',
    cheapestPrice: result.cheapestPrice,
    prices: result.prices,
    message: `${target.displayValue}: Bilet görünür. Ən ucuz qiymət ${formatPrice(result.cheapestPrice)} AZN.`,
    screenshotPath,
  };
}

async function waitForHomeReady(page: Page, runtimeConfig: RuntimeConfig): Promise<void> {
  await page.goto(runtimeConfig.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const form = page.locator('form.search__wrapper');
  try {
    await form.waitFor({ state: 'visible', timeout: 90000 });
  } catch {
    const title = await page.title().catch(() => '');
    throw new Error(`Axtarış formu açılmadı. Title: "${title}". Cloudflare yoxlaması varsa, görünən browserdə tamamla və yenidən işə sal.`);
  }
}

async function closeOpenPopups(page: Page): Promise<void> {
  const closeButtons = page.locator('.popup.open .popup__close-btn');
  const count = await closeButtons.count().catch(() => 0);

  for (let index = count - 1; index >= 0; index -= 1) {
    await closeButtons.nth(index).click({ timeout: 1000 }).catch(() => {});
  }
}

async function selectStation(page: Page, groupSelector: string, query: string, exactText: string): Promise<void> {
  const group = page.locator(groupSelector);
  const input = group.locator('input.form-control');

  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.click();
  await input.fill(query);

  const option = group.locator('.custom-select button').filter({ hasText: exactText });
  await option.waitFor({ state: 'visible', timeout: 30000 });
  await option.click();

  await waitForInputValue(input, exactText, 10000);
}

async function selectTargetDate(page: Page, target: TargetDate): Promise<DateSelectionResult> {
  const input = page.locator('form.search__wrapper input[placeholder="Gediş tarixi"]');
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.click();

  const calendar = page.locator('form.search__wrapper .calendar.open');
  await calendar.waitFor({ state: 'visible', timeout: 30000 });

  const month = calendar.locator('.calendar__table__item').filter({ hasText: target.monthLabel });
  const monthCount = await month.count();

  if (monthCount === 0) {
    return {
      ok: false,
      status: 'date-not-loaded',
      message: `${target.monthLabel} ayı calendar-da görünmədi.`,
    };
  }

  const day = month.locator('td').filter({ hasText: new RegExp(`^\\s*${target.day}(\\s|$)`) });
  const dayCount = await day.count();

  if (dayCount === 0) {
    return {
      ok: false,
      status: 'date-not-found',
      message: `${target.displayValue} calendar-da tapılmadı.`,
    };
  }

  const dayCell = day.first();
  const className = (await dayCell.getAttribute('class')) || '';
  if (className.split(/\s+/).includes('old')) {
    return {
      ok: false,
      status: 'date-disabled',
      message: `${target.displayValue} hazırda qeyri-aktivdir; axtarış göndərilmir.`,
    };
  }

  await dayCell.scrollIntoViewIfNeeded();
  await dayCell.click();
  await waitForInputValue(input, target.displayValue, 10000);

  return { ok: true, status: 'date-selected', message: `${target.displayValue} seçildi.` };
}

async function setAdults(page: Page, adults: number): Promise<void> {
  const passengerInput = page.locator('form.search__wrapper input[placeholder="Sərnişinlər"]');
  await passengerInput.waitFor({ state: 'visible', timeout: 30000 });
  await passengerInput.click();

  const adultItem = page.locator('form.search__wrapper .form-group--count .count-select__item').first();
  const adultValueInput = adultItem.locator('input.form-control');
  const plus = adultItem.locator('button.form-button--plus');
  const minus = adultItem.locator('button.minus, button.form-button--minus');

  await adultValueInput.waitFor({ state: 'visible', timeout: 10000 });

  let current = Number(await adultValueInput.inputValue());
  while (current < adults) {
    await plus.click();
    current += 1;
  }

  while (current > adults) {
    await minus.click();
    current -= 1;
  }

  await waitForInputValue(passengerInput, `${adults} b.`, 10000);
}

async function submitSearch(page: Page, runtimeConfig: RuntimeConfig): Promise<SearchOutcome | 'sold-out' | 'unknown'> {
  const searchButton = page.locator('form.search__wrapper button.btn.btn-blue').filter({ hasText: 'Axtar' });
  await searchButton.waitFor({ state: 'visible', timeout: 30000 });
  await searchButton.click();

  const continueButton = page.locator('.popup.open button.btn.btn-blue').filter({ hasText: CONTINUE_TEXT });
  const appeared = await waitForVisible(continueButton, 15000);
  if (appeared) {
    const log = runtimeConfig.log ?? defaultLog;
    log(`"${CONTINUE_TEXT}" modalı göründü, basılır.`);
    await continueButton.click();
  }

  return waitForSearchOutcome(page, runtimeConfig);
}

async function waitForSearchOutcome(page: Page, runtimeConfig: RuntimeConfig): Promise<SearchOutcome | 'sold-out' | 'unknown'> {
  try {
    const resultHandle = await page.waitForFunction(
      ({ soldOutText }: { soldOutText: string }) => {
        const isVisible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          );
        };

        const elementText = (element: Element) => ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();

        const extractVisiblePrices = () => {
          const prices: number[] = [];
          const elements = [...document.querySelectorAll('body *')].filter(isVisible);

          for (const element of elements) {
            const text = elementText(element);
            if (!text) continue;

            const className = String(element.className || '');
            const hasManatSvg = [...element.querySelectorAll('use')].some((use) => {
              const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
              return href.toLowerCase().includes('manat');
            });
            const looksLikePrice =
              hasManatSvg ||
              /₼|azn|manat/i.test(text) ||
              /price|fare|amount|cost|qiym/i.test(className);

            if (!looksLikePrice) continue;

            const regex = /(^|[^\d])(\d{1,4}[.,]\d{2})(?!\d)/g;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(text))) {
              const value = Number(match[2].replace(',', '.'));
              if (Number.isFinite(value) && value > 0 && value < 1000) {
                prices.push(value);
              }
            }
          }

          return [...new Set(prices)].sort((a, b) => a - b);
        };

        const soldOutModal = [...document.querySelectorAll('.popup.open')].find(
          (element) => isVisible(element) && elementText(element).includes(soldOutText),
        );
        if (soldOutModal) return 'sold-out';

        const loading = [...document.querySelectorAll('[class*="loading"], [class*="loader"], [class*="spinner"], .lds-ring')].some(
          (element) => isVisible(element),
        );
        const text = document.body.innerText || '';
        if (!loading && text.includes('Qatar seçimi')) {
          const prices = extractVisiblePrices();
          if (prices.length > 0) {
            return {
              status: 'tickets-found',
              cheapestPrice: prices[0],
              prices,
            };
          }
        }

        return false;
      },
      { soldOutText: SOLD_OUT_TEXT },
      { timeout: runtimeConfig.resultWaitMs },
    );

    const value = await resultHandle.jsonValue();
    return value as SearchOutcome | 'sold-out';
  } catch {
    return 'unknown';
  }
}

async function waitForInputValue(locator: Locator, expectedPart: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await locator.inputValue().catch(() => '');
    if (value.includes(expectedPart)) return value;
    await delay(200);
  }

  const value = await locator.inputValue().catch(() => '');
  throw new Error(`Input dəyəri gözlənilən olmadı. Gözlənən: "${expectedPart}", gələn: "${value}"`);
}

async function waitForVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function saveScreenshot(page: Page, prefix: string, runtimeConfig: RuntimeConfig): Promise<string | null> {
  if (!runtimeConfig.screenshotsEnabled) return null;

  const dir = path.resolve(process.cwd(), runtimeConfig.artifactsDir);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${prefix}-${stamp}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

export function formatPrice(value: number): string {
  return Number(value).toFixed(2);
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
