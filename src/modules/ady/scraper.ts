import fs from 'node:fs/promises';
import path from 'node:path';
import {type BrowserContext, chromium, type Page, type Response} from 'playwright';
import {type AdyStation, getStationById, getTicketStationId, matchStationText,} from './stations';

export const MAX_ADULTS = 4;
export const MAX_CHILD = 4;

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
  browserCdpUrl: string;
  browserProfileDir: string;
  screenshotsEnabled: boolean;
  pageDiagnosticsEnabled: boolean;
  pageDiagnosticsTextLimit: number;
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
  infant: number;
  child: number;
  maxPrice: number;
  ticketTypes: string[];
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
  infant?: number | string;
  child?: number | string;
  maxPrice?: number | string;
  ticketTypes?: string | string[];
}

export type DateSkippedStatus = 'date-not-loaded' | 'date-not-found' | 'date-disabled';
export type CheckStatus = DateSkippedStatus | 'sold-out' | 'unknown' | 'tickets-found';
export type SummaryStatus = 'price-ok' | 'price-too-high' | 'date-disabled' | 'no-match' | 'unknown';

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
  ticketTypes: string[];
  ticketSearchUrl?: string | null;
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
  ticketSearchUrl?: string | null;
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
  ticketTypes: string[];
  ticketSearchUrl?: string | null;
}

type TicketSearchLoadResult =
  | { status: 'ready' }
  | { status: 'sold-out'; message: string }
  | { status: 'unknown'; message: string };

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

function nonNegativeIntegerFromEnv(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
    browserCdpUrl: env.ADY_BROWSER_CDP_URL || '',
    browserProfileDir: env.ADY_BROWSER_PROFILE_DIR || '.browser-profile',
    screenshotsEnabled: parseBoolean(env.ADY_SCREENSHOTS_ENABLED, true),
    pageDiagnosticsEnabled: parseBoolean(env.ADY_PAGE_DIAGNOSTICS_ENABLED, true),
    pageDiagnosticsTextLimit: numberFromEnv(env.ADY_PAGE_DIAGNOSTICS_TEXT_LIMIT, 1800),
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
    adults: nonNegativeIntegerFromEnv(env.ADY_ADULTS, 3),
    infant: nonNegativeIntegerFromEnv(env.ADY_INFANT, 0),
    child: nonNegativeIntegerFromEnv(env.ADY_CHILD, 0),
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
  const infant = Number(input.infant ?? 0);
  const child = Number(input.child ?? 0);
  const maxPrice = Number(input.maxPrice);
  const ticketTypes = normalizeTicketTypes(input.ticketTypes);

  if (!from.exact || !to.exact) {
    throw new Error('Haradan və haraya stansiyaları yazılmalıdır.');
  }

  validatePassengers({ adults, infant, child });

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
    infant,
    child,
    maxPrice,
    ticketTypes,
  };
}

export function validatePassengers(passengers: Pick<AdyRequest, 'adults' | 'infant' | 'child'>): void {
  const { adults, infant, child } = passengers;
  if (!Number.isInteger(adults) || adults < 1 || adults > MAX_ADULTS) {
    throw new Error(`Böyük sərnişin sayı 1-${MAX_ADULTS} arasında tam ədəd olmalıdır.`);
  }

  const maxInfant = MAX_ADULTS - adults;
  if (!Number.isInteger(infant) || infant < 0 || infant > maxInfant) {
    throw new Error(`Uşaq (10 yaşa qədər) sayı 0-${maxInfant} arasında tam ədəd olmalıdır.`);
  }

  if (!Number.isInteger(child) || child < 0 || child > MAX_CHILD) {
    throw new Error(`Körpə sayı 0-${MAX_CHILD} arasında tam ədəd olmalıdır.`);
  }
}

function normalizeTicketTypes(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
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
    const knownStation = getStationById(station) ?? matchStationText(station);
    if (knownStation) return { ...knownStation };
    return { id: station, exact: station, query: station, label: station, country: '' };
  }

  const knownStation =
    (station?.id ? getStationById(station.id) : null) ??
    matchStationText(station?.exact || station?.label || station?.value || station?.query || '');
  if (knownStation) return { ...knownStation };

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
    infant: request.infant,
    child: request.child,
  });
}

export function buildTicketSearchUrl(
  requestInput: AdyRequestInput | AdyRequest,
  target: TargetDate,
  baseUrl = 'https://ticket.ady.az/',
): string {
  const request = normalizeRequest(requestInput);
  const fromStationId = getTicketStationId(request.from.id);
  const toStationId = getTicketStationId(request.to.id);

  if (fromStationId == null || toStationId == null) {
    throw new Error(
      `Birbaşa URL axtarışı bu marşrut üçün dəstəklənmir: ${request.from.label} -> ${request.to.label}.`,
    );
  }

  const url = new URL(baseUrl);
  const date = `${target.day}/${target.month}/${target.year}`;
  url.pathname = `/az/ticket-search/${request.from.id}-${request.to.id}`;
  url.search = new URLSearchParams({
    from_station: String(fromStationId),
    to_station: String(toStationId),
    date,
    return_date: date,
    two_way: 'false',
    child: String(request.child),
    infant: String(request.infant),
    adults: String(request.adults),
  }).toString();
  return url.href;
}

function now(): string {
  return new Date().toLocaleString('az-AZ', { hour12: false });
}

function defaultLog(message: string): void {
  console.log(`[${now()}] ${message}`);
}

export async function launchBrowser(runtimeConfigInput: Partial<RuntimeConfig> = {}): Promise<BrowserContext> {
  const runtimeConfig = buildRuntimeConfig(process.env, runtimeConfigInput);
  const log = runtimeConfig.log ?? defaultLog;

  if (runtimeConfig.browserCdpUrl) {
    const browser = await chromium.connectOverCDP(runtimeConfig.browserCdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error(`CDP browser context tapılmadı: ${runtimeConfig.browserCdpUrl}`);
    }

    // A CDP browser is launched outside this process; disconnecting must not close the user's Chrome session.
    context.close = async () => {
      await browser.close();
    };
    log(`Mövcud Chrome sessiyasına qoşuldu (CDP: ${runtimeConfig.browserCdpUrl}).`);
    return context;
  }

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
  const unknownResults: CheckResult[] = [];

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

    if (result.status === 'unknown') {
      unknownResults.push(result);
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

  if (unknownResults.length > 0) {
    return {
      ok: false,
      status: 'unknown',
      results: batch.results,
      message: `${unknownResults.map((result) => result.target.displayValue).join(', ')} üçün ADY nəticəsi tam müəyyən olmadı; növbəti yoxlamada yenidən cəhd ediləcək.`,
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
  const ticketSearchUrl = buildTicketSearchUrl(request, target, runtimeConfig.url);
  log(
    `Yoxlama başlayır: ${request.from.exact} -> ${request.to.exact}, ${target.displayValue}, ${formatPassengers(request)}.`,
  );

  try {
    const loadResult = await openTicketSearch(page, ticketSearchUrl, runtimeConfig);
    if (loadResult.status === 'unknown') {
      await logPageDiagnostics(page, runtimeConfig, 'ticket-api-error');
      const screenshotPath = await saveScreenshot(page, 'unknown', runtimeConfig);
      return {
        ok: false,
        target,
        status: 'unknown',
        message: `${target.displayValue}: ${loadResult.message} Notification göndərilmir.`,
        screenshotPath,
      };
    }

    if (loadResult.status === 'sold-out') {
      return {
        ok: true,
        target,
        status: 'sold-out',
        message: `${target.displayValue}: ${loadResult.message}`,
      };
    }

    const result = await waitForSearchOutcome(page, runtimeConfig);
    if (result === 'sold-out') {
      return {
        ok: true,
        target,
        status: 'sold-out',
        message: `${target.displayValue}: Uyğun bilet yoxdur (.ticket__item tapılmadı).`,
      };
    }

    if (result === 'unknown') {
      await logPageDiagnostics(page, runtimeConfig, 'search-outcome-unknown');
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
    const priceText = result.cheapestPrice > 0 ? ` Ən ucuz qiymət ${formatPrice(result.cheapestPrice)} AZN.` : '';
    return {
      ok: true,
      target,
      status: 'tickets-found',
      cheapestPrice: result.cheapestPrice,
      prices: result.prices,
      ticketTypes: result.ticketTypes,
      ticketSearchUrl,
      message: `${target.displayValue}: Bilet görünür. Tip: ${formatTicketTypes(result.ticketTypes)}.${priceText}`,
      screenshotPath,
    };
  } catch (error) {
    await logPageDiagnostics(page, runtimeConfig, 'check-error');
    throw error;
  }
}

async function openTicketSearch(
  page: Page,
  ticketSearchUrl: string,
  runtimeConfig: RuntimeConfig,
): Promise<TicketSearchLoadResult> {
  const ticketApiResponse = page.waitForResponse(
    (response) => response.url().includes('/ticket-api/get_traintrip') && response.request().method() === 'POST',
    { timeout: runtimeConfig.resultWaitMs },
  );

  try {
    await page.goto(ticketSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    const response = await ticketApiResponse;
    const result = await getTicketApiResult(response, runtimeConfig.log ?? defaultLog);
    if (result.status !== 'ready') return result;

    // The ticket page renders the response asynchronously after the API resolves.
    await delay(500);
    return { status: 'ready' };
  } catch (error) {
    return {
      status: 'unknown',
      message: `ADY bilet API cavabı alınmadı: ${getErrorMessage(error)}.`,
    };
  }
}

async function getTicketApiResult(response: Response, log: LogFn): Promise<TicketSearchLoadResult> {
  // Read the raw body once so the exact API response can be preserved in a 422 diagnostic.
  const responseBody = await response.text().catch(() => '');
  let payload: unknown = null;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    // A non-JSON error response is still classified by its HTTP status below.
  }

  if (response.status() === 422) {
    const request = response.request();
    log(`[ADY 422 request] ${request.method()} ${response.url()}`);
    log(`[ADY 422 request] payload=${request.postData() ?? '[empty]'}`);
    log(`[ADY 422 response] body=${responseBody || '[empty]'}`);
  }

  return classifyTicketApiResult(response.status(), payload);
}

export function classifyTicketApiResult(status: number, payload: unknown): TicketSearchLoadResult {
  const response = isRecord(payload) ? payload : {};
  const message = typeof response.message === 'string' ? response.message.trim() : '';

  if (status < 200 || status >= 300) {
    return {
      status: 'unknown',
      message: `ADY bilet API xətası (${status})${message ? `: ${message}.` : '.'}`,
    };
  }

  if (response.error === true) {
    return {
      status: 'sold-out',
      message: `Uyğun bilet yoxdur${message ? `: ${message}.` : '.'}`,
    };
  }

  return { status: 'ready' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

async function waitForSearchOutcome(page: Page, runtimeConfig: RuntimeConfig): Promise<SearchOutcome | 'sold-out' | 'unknown'> {
  try {
    const resultHandle = await page.waitForFunction(
      () => {
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
          return [...document.querySelectorAll('a.ticket__price > span')]
            .filter(isVisible)
            .map((element) => elementText(element))
            .map((text) => {
              const match = text.match(/(\d{1,3}(?:[\s\u00a0]\d{3})*[.,]\d{2})/);
              if (!match) return null;

              const value = Number(match[1].replace(/[\s\u00a0]/g, '').replace(',', '.'));
              return Number.isFinite(value) && value > 0 ? value : null;
            })
            .filter((value): value is number => value != null)
            .filter((value, index, prices) => prices.indexOf(value) === index)
            .sort((a, b) => a - b);
        };

        const extractVisibleTicketTypes = () => {
          const labels = [...document.querySelectorAll('.ticket__item .ticket__type li label nobr, .ticket__type li label nobr')]
            .filter(isVisible)
            .map((element) => elementText(element))
            .filter(Boolean);

          return [...new Set(labels)];
        };

        const loading = [...document.querySelectorAll('[class*="loading"], [class*="loader"], [class*="spinner"], .lds-ring')].some(
          (element) => isVisible(element),
        );
        if (document.readyState !== 'complete' || loading) return false;

        const pageText = document.body.innerText || document.body.textContent || '';
        if (/cloudflare|just a moment|checking if the site connection is secure|verify you are human/i.test(pageText)) {
          return false;
        }

        const ticketItems = [...document.querySelectorAll('.ticket__item')].filter(isVisible);
        if (ticketItems.length === 0) return 'sold-out';

        const prices = extractVisiblePrices();
        if (prices.length === 0) return false;

        const ticketTypes = extractVisibleTicketTypes();
        return {
          status: 'tickets-found',
          cheapestPrice: prices[0] ?? 0,
          prices,
          ticketTypes,
        };
      },
      { timeout: runtimeConfig.resultWaitMs },
    );

    const value = await resultHandle.jsonValue();
    return value as SearchOutcome | 'sold-out';
  } catch {
    return 'unknown';
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

async function logPageDiagnostics(page: Page, runtimeConfig: RuntimeConfig, reason: string): Promise<void> {
  if (!runtimeConfig.pageDiagnosticsEnabled) return;

  const log = runtimeConfig.log ?? defaultLog;
  const label = sanitizeDiagnosticLabel(reason);

  try {
    const snapshot = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      const visible = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText,
        ticketItemCount: document.querySelectorAll('.ticket__item').length,
        hasVisibleLoader: visible('[class*="loading"], [class*="loader"], [class*="spinner"], .lds-ring'),
        hasCloudflareSignals: /cloudflare|just a moment|checking if the site connection is secure|verify you are human/i.test(bodyText),
      };
    });
    const bodyText = truncateForLog(snapshot.bodyText || '[empty]', runtimeConfig.pageDiagnosticsTextLimit);

    log(`[ADY diagnostic:${label}] url=${snapshot.url}`);
    log(`[ADY diagnostic:${label}] title="${snapshot.title}" readyState=${snapshot.readyState} ticketItems=${snapshot.ticketItemCount} visibleLoader=${snapshot.hasVisibleLoader} cloudflareSignals=${snapshot.hasCloudflareSignals}`);
    log(`[ADY diagnostic:${label}] body="${bodyText}"`);
  } catch (error) {
    log(`[ADY diagnostic:${label}] page snapshot oxunmadı: ${getErrorMessage(error)}`);
  }

  const screenshotPath = await saveDiagnosticScreenshot(page, label, runtimeConfig);
  if (screenshotPath) {
    log(`[ADY diagnostic:${label}] screenshot=${screenshotPath}`);
  }
}

async function saveDiagnosticScreenshot(page: Page, label: string, runtimeConfig: RuntimeConfig): Promise<string | null> {
  try {
    const dir = path.resolve(process.cwd(), runtimeConfig.artifactsDir);
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `diagnostic-${label}-${stamp}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

function truncateForLog(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function sanitizeDiagnosticLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatPrice(value: number): string {
  return Number(value).toFixed(2);
}

export function parseTicketPrice(value: string): number | null {
  const match = value.match(/(\d{1,3}(?:[\s\u00a0]\d{3})*[.,]\d{2})/);
  if (!match) return null;

  const parsed = Number(match[1].replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function formatPassengers(passengers: Pick<AdyRequest, 'adults' | 'infant' | 'child'>): string {
  return `Böyük: ${passengers.adults}, Uşaq (10 yaşa qədər): ${passengers.infant}, Körpə: ${passengers.child}`;
}

function formatTicketTypes(ticketTypes: string[]): string {
  return ticketTypes.length > 0 ? ticketTypes.join(', ') : 'bilinmir';
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
