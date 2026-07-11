import dotenv from 'dotenv';
import TelegramBot, {
  type CallbackQuery,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type Message,
  type User,
} from 'node-telegram-bot-api';
import {
  ADY_STATIONS,
  getStationById,
  matchStationText,
  stationDisplay,
  type AdyStation,
} from './modules/ady/stations';
import type { AdyRequest, CheckBatch, TicketsFoundResult } from './modules/ady/scraper';
import {
  buildCalendarKeyboard,
  currentMonthCursor,
  formatSelectedDates,
  parseCursor,
  toIsoDate,
  type CalendarCursor,
} from './bot/calendar';
import {
  AdyJobManager,
  type AdySubscriber,
  type AvailableEvent,
  type CheckFailedEvent,
  type CheckedEvent,
  type JobErrorEvent,
} from './bot/job-manager';

dotenv.config({ quiet: true });

type StationField = 'from' | 'to';
type ChatId = number | string;
type TicketTypeId = 'comfort' | 'luxury' | 'standard-plus';
type TicketTypeOption = {
  id: TicketTypeId;
  label: string;
  aliases: string[];
};

interface BotSession {
  service: 'ady';
  step: 'service' | StationField | 'dates' | 'adults' | 'ticketTypes' | 'confirm';
  fromStationId: string | null;
  toStationId: string | null;
  selectedDates: Set<string>;
  calendarCursor: CalendarCursor;
  adults: number | null;
  selectedTicketTypeIds: Set<TicketTypeId>;
}

interface ReplyMarkupOptions {
  reply_markup?: InlineKeyboardMarkup;
}

interface TelegramCommand {
  command: string;
  description: string;
}

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.ADY_TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN .env faylında yazılmalıdır.');
}

const allowedChatIds = parseCsv(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.ADY_TELEGRAM_ALLOWED_CHAT_IDS || '');
const maxSelectedDates = Math.min(positiveInteger(process.env.ADY_BOT_MAX_DATES, 4), 4);
const maxPassengers = positiveInteger(process.env.ADY_BOT_MAX_PASSENGERS, 10);
const stationsPerPage = positiveInteger(process.env.ADY_BOT_STATIONS_PER_PAGE, 8);
const ADY_FROM_STATION_IDS = ['baki-dyv', 'bileceri', 'yevlax', 'gence', 'agstafa', 'boyuk-kesik'] as const;
const ADY_TO_STATION_IDS = ['tbilisi-sern', 'qardabani'] as const;
const TICKET_TYPE_OPTIONS: TicketTypeOption[] = [
  { id: 'comfort', label: 'Komfort+', aliases: ['Komfort', 'Komfort+'] },
  { id: 'luxury', label: 'Lüks', aliases: ['Lüks'] },
  { id: 'standard-plus', label: 'Standart+', aliases: ['Standart+'] },
];
const BOT_COMMANDS: TelegramCommand[] = [
  { command: 'start', description: 'Bot menyusunu aç' },
  { command: 'ady', description: 'ADY bilet axtarışına başla' },
  { command: 'status', description: 'Aktiv monitorinqləri göstər' },
  { command: 'stop', description: 'Monitorinqi dayandır' },
];

const sessions = new Map<string, BotSession>();
const bot = new TelegramBot(token, { polling: true });
const jobManager = new AdyJobManager({
  runtimeConfig: {
    screenshotsEnabled: parseBoolean(process.env.ADY_BOT_SCREENSHOTS_ENABLED, false),
  },
  log: (message) => console.log(message),
});

bot.onText(/^\/start\b/, async (message: Message) => {
  if (!isAllowed(message.chat.id)) return;
  sessions.set(String(message.chat.id), createSession());
  await showServiceMenu(message.chat.id);
});

bot.onText(/^\/ady\b/, async (message: Message) => {
  if (!isAllowed(message.chat.id)) return;
  sessions.set(String(message.chat.id), createSession());
  await showStationSelector(message.chat.id, 'from', 0);
});

bot.onText(/^\/stop\b/, async (message: Message) => {
  if (!isAllowed(message.chat.id)) return;
  sessions.delete(String(message.chat.id));
  const removed = jobManager.unsubscribeChat(message.chat.id);
  await bot.sendMessage(message.chat.id, removed > 0
    ? `${removed} ADY monitorinqi dayandırıldı.`
    : 'Aktiv monitorinq tapılmadı.');
});

bot.onText(/^\/status\b/, async (message: Message) => {
  if (!isAllowed(message.chat.id)) return;
  const jobs = jobManager.getChatJobs(message.chat.id);
  if (jobs.length === 0) {
    await bot.sendMessage(message.chat.id, 'Aktiv ADY monitorinqin yoxdur.');
    return;
  }

  const lines = jobs.map(({ job, subscriber }, index) => {
    const lastRun = job.lastRunAt ? job.lastRunAt.toLocaleString('az-AZ', { hour12: false }) : 'hələ yoxlanmayıb';
    return [
      `${index + 1}. ${job.request.from.label} -> ${job.request.to.label}`,
      `Tək gediş tarixləri: ${job.request.targetDates.map((target) => target.iso).join(', ')}`,
      `Sərnişin: ${job.request.adults}, zal tipi: ${formatTicketTypes(subscriber.ticketTypes)}`,
      `Yoxlama limiti: ${subscriber.checksCompleted}/${subscriber.maxChecks}`,
      `Son yoxlama: ${lastRun}`,
    ].join('\n');
  });

  await bot.sendMessage(message.chat.id, lines.join('\n\n'));
});

bot.on('callback_query', async (query: CallbackQuery) => {
  const chatId = query.message?.chat?.id;
  if (!chatId || !isAllowed(chatId)) return;

  const data = query.data || '';
  if (data === 'noop') {
    await answerCallback(query.id);
    return;
  }

  try {
    await handleCallback(query, data);
  } catch (error) {
    console.error(error);
    await answerCallback(query.id, 'Xəta oldu. Yenidən cəhd et.');
  }
});

bot.on('message', async (message: Message) => {
  if (!message.text || message.text.startsWith('/')) return;
  if (!isAllowed(message.chat.id)) return;

  try {
    await handleTextMessage(message);
  } catch (error) {
    console.error(error);
    await bot.sendMessage(message.chat.id, 'Xəta oldu. Yenidən /start ilə başla.');
  }
});

jobManager.on('available', async (event: AvailableEvent) => {
  await bot.sendMessage(event.subscriber.chatId, event.message).catch((error: Error) => {
    console.error(`Telegram mesajı göndərilmədi (${event.subscriber.chatId}): ${error.message}`);
  });
});

jobManager.on('checked', async (event: CheckedEvent) => {
  const expiredChatIds = new Set(event.expiredSubscribers.map((subscriber) => subscriber.chatId));

  await Promise.all(event.subscribers.map(async (subscriber) => {
    if (hasMatchingTicket(event.batch, subscriber.ticketTypes)) return;

    await bot.sendMessage(
      subscriber.chatId,
      buildNoTicketsMessage(event.job.request, event.batch, subscriber, event.nextCheckInMs, expiredChatIds.has(subscriber.chatId)),
    ).catch((error: Error) => {
      console.error(`Telegram status mesajı göndərilmədi (${subscriber.chatId}): ${error.message}`);
    });
  }));
});

jobManager.on('check-failed', async (event: CheckFailedEvent) => {
  const expiredChatIds = new Set(event.expiredSubscribers.map((subscriber) => subscriber.chatId));

  await Promise.all(event.subscribers.map(async (subscriber) => {
    await bot.sendMessage(
      subscriber.chatId,
      buildCheckFailedMessage(event.job.request, subscriber, event.nextCheckInMs, expiredChatIds.has(subscriber.chatId)),
    ).catch((error: Error) => {
      console.error(`Telegram xeta status mesaji gonderilmedi (${subscriber.chatId}): ${error.message}`);
    });
  }));
});

jobManager.on('job-error', ({ job, error }: JobErrorEvent) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ADY] ${job.request.from.exact} -> ${job.request.to.exact}: ${message}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

registerBotCommands().catch((error: unknown) => {
  console.error(`Telegram command menyusu yenilənmədi: ${formatErrorMessage(error)}`);
});
console.log('Telegram bot işə düşdü.');

async function registerBotCommands(): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: BOT_COMMANDS }),
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json() as { ok?: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description || 'setMyCommands failed');
  }

  console.log('Telegram command menyusu yeniləndi.');
}

async function handleCallback(query: CallbackQuery, data: string): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId) return;

  if (data === 'svc:ady') {
    sessions.set(String(chatId), createSession());
    await answerCallback(query.id);
    await showStationSelector(chatId, 'from', 0, messageId);
    return;
  }

  if (data.startsWith('sp:')) {
    const [, fieldText, pageText] = data.split(':');
    const field = parseStationField(fieldText);
    if (!field) {
      await answerCallback(query.id, 'Yanlış seçim.');
      return;
    }

    await answerCallback(query.id);
    await showStationSelector(chatId, field, Number(pageText), messageId);
    return;
  }

  if (data.startsWith('st:')) {
    const [, fieldText, stationId] = data.split(':');
    const field = parseStationField(fieldText);
    const station = stationId ? getStationById(stationId) : null;
    if (!field || !station || !isStationAllowedForField(field, station)) {
      await answerCallback(query.id, 'Bu istiqamət mövcud deyil.');
      return;
    }

    const session = ensureSession(chatId);
    const accepted = await setStationSelection(chatId, session, field, station, query.id);
    if (!accepted) return;

    await answerCallback(query.id);
    if (field === 'from') {
      await showStationSelector(chatId, 'to', 0);
    } else {
      await showCalendar(chatId);
    }
    return;
  }

  if (data.startsWith('cal:nav:')) {
    const session = ensureSession(chatId);
    session.calendarCursor = parseCursor(data.replace('cal:nav:', ''));
    await answerCallback(query.id);
    await showCalendar(chatId, messageId);
    return;
  }

  if (data.startsWith('cal:t:')) {
    const session = ensureSession(chatId);
    const iso = data.replace('cal:t:', '');
    if (session.selectedDates.has(iso)) {
      session.selectedDates.delete(iso);
    } else if (session.selectedDates.size >= maxSelectedDates) {
      await answerCallback(query.id, `Maksimum ${maxSelectedDates} tarix seçilə bilər.`);
      return;
    } else {
      session.selectedDates.add(iso);
    }

    await answerCallback(query.id);
    await showCalendar(chatId, messageId);
    return;
  }

  if (data === 'cal:done') {
    const session = ensureSession(chatId);
    if (session.selectedDates.size === 0) {
      await answerCallback(query.id, 'Ən azı bir tarix seç.');
      return;
    }

    await answerCallback(query.id);
    await askAdults(chatId);
    return;
  }

  if (data.startsWith('p:')) {
    const adults = Number(data.replace('p:', ''));
    const session = ensureSession(chatId);
    session.adults = adults;
    session.step = 'ticketTypes';
    await answerCallback(query.id);
    await showTicketTypeSelector(chatId);
    return;
  }

  if (data.startsWith('tt:toggle:')) {
    const session = ensureSession(chatId);
    const ticketTypeId = parseTicketTypeId(data.replace('tt:toggle:', ''));
    if (!ticketTypeId) {
      await answerCallback(query.id, 'Yanlış seçim.');
      return;
    }

    if (session.selectedTicketTypeIds.has(ticketTypeId)) {
      session.selectedTicketTypeIds.delete(ticketTypeId);
    } else {
      session.selectedTicketTypeIds.add(ticketTypeId);
    }

    await answerCallback(query.id);
    await showTicketTypeSelector(chatId, messageId);
    return;
  }

  if (data === 'tt:done') {
    const session = ensureSession(chatId);
    if (session.selectedTicketTypeIds.size === 0) {
      await answerCallback(query.id, 'Ən azı bir zal tipi seç.');
      return;
    }

    session.step = 'confirm';
    await answerCallback(query.id);
    await showConfirm(chatId, session);
    return;
  }

  if (data === 'confirm:start') {
    const session = ensureSession(chatId);
    await answerCallback(query.id);
    await startMonitoring(chatId, query.from, session);
    return;
  }

  if (data === 'confirm:cancel') {
    sessions.delete(String(chatId));
    await answerCallback(query.id);
    await bot.sendMessage(chatId, 'Ləğv edildi.');
  }
}

async function handleTextMessage(message: Message): Promise<void> {
  const chatId = message.chat.id;
  const session = ensureSession(chatId);
  const text = message.text?.trim() ?? '';

  if (session.step === 'from' || session.step === 'to') {
    const field = session.step;
    const station = matchStationForField(field, text);
    if (!station) {
      await bot.sendMessage(chatId, stationHelpText(field));
      return;
    }

    const accepted = await setStationSelection(chatId, session, field, station);
    if (!accepted) return;

    if (field === 'from') {
      await showStationSelector(chatId, 'to', 0);
    } else {
      await showCalendar(chatId);
    }
    return;
  }

  if (session.step === 'adults') {
    const adults = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isInteger(adults) || adults < 1 || adults > maxPassengers) {
      await bot.sendMessage(chatId, `Sərnişin sayını 1-${maxPassengers} arası rəqəm kimi yaz.`);
      return;
    }

    session.adults = adults;
    session.step = 'ticketTypes';
    await showTicketTypeSelector(chatId);
    return;
  }

  if (session.step === 'ticketTypes') {
    const ticketTypeIds = parseTicketTypeText(text);
    if (ticketTypeIds.length === 0) {
      await bot.sendMessage(chatId, 'Zal tipini seç: Komfort+, Lüks və ya Standart+.');
      await showTicketTypeSelector(chatId);
      return;
    }

    session.selectedTicketTypeIds = new Set(ticketTypeIds);
    session.step = 'confirm';
    await showConfirm(chatId, session);
    return;
  }

  await bot.sendMessage(chatId, 'Yeni sorğu üçün /start yaz.');
}

async function setStationSelection(
  chatId: ChatId,
  session: BotSession,
  field: StationField,
  station: AdyStation,
  callbackQueryId?: string,
): Promise<boolean> {
  if (field === 'to' && station.id === session.fromStationId) {
    if (callbackQueryId) {
      await answerCallback(callbackQueryId, 'Haradan və haraya eyni ola bilməz.');
    } else {
      await bot.sendMessage(chatId, 'Haradan və haraya eyni ola bilməz.');
    }
    return false;
  }

  if (field === 'from') {
    session.fromStationId = station.id;
    session.step = 'to';
  } else {
    session.toStationId = station.id;
    session.step = 'dates';
  }

  return true;
}

async function showServiceMenu(chatId: ChatId): Promise<void> {
  await bot.sendMessage(chatId, 'Nə izləyək?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'ADY.az', callback_data: 'svc:ady' }],
      ],
    },
  });
}

async function showStationSelector(
  chatId: ChatId,
  field: StationField,
  page = 0,
  editMessageId: number | undefined = undefined,
): Promise<void> {
  const session = ensureSession(chatId);
  session.step = field;
  const excludedId = field === 'to' ? session.fromStationId : null;
  const stations = getStationsForField(field).filter((station) => station.id !== excludedId);
  const pageCount = Math.max(1, Math.ceil(stations.length / stationsPerPage));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = safePage * stationsPerPage;
  const pageStations = stations.slice(start, start + stationsPerPage);
  const rows: InlineKeyboardButton[][] = pageStations.map((station) => ([
    { text: stationDisplay(station), callback_data: `st:${field}:${station.id}` },
  ]));

  if (pageCount > 1) {
    rows.push([
      { text: '<', callback_data: `sp:${field}:${Math.max(0, safePage - 1)}` },
      { text: `${safePage + 1}/${pageCount}`, callback_data: 'noop' },
      { text: '>', callback_data: `sp:${field}:${Math.min(pageCount - 1, safePage + 1)}` },
    ]);
  }

  const text = field === 'from'
    ? [
      'Haradan gedirsən?',
      'Mövcud istiqamət yalnız Azərbaycandan Tbilisi və ya Qardabani tərəfədir.',
      'Seçimlər: Bakı, Biləcəri, Yevlax, Gəncə, Ağstafa, Böyük-Kəsik.',
    ].join('\n')
    : [
      'Haraya gedirsən?',
      'Son məntəqə yalnız Tbilisi-Sərn və ya Qardabani seçilə bilər.',
    ].join('\n');

  await sendOrEdit(chatId, editMessageId, text, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function showCalendar(chatId: ChatId, editMessageId: number | undefined = undefined): Promise<void> {
  const session = ensureSession(chatId);
  session.step = 'dates';
  const selected = formatSelectedDates(session.selectedDates) || 'yoxdur';
  const text = [
    'Gediş tarixlərini seç.',
    'Yalnız tək istiqamət seçilir, ona görə qayıdış tarixi yoxdur.',
    `Sadəcə gediş tarixlərini seç; birdən çox tarix ola bilər. Maksimum ${maxSelectedDates} gün.`,
    `Seçilənlər: ${selected}`,
  ].join('\n');

  await sendOrEdit(chatId, editMessageId, text, {
    reply_markup: buildCalendarKeyboard(session.calendarCursor, session.selectedDates, {
      maxSelectedDates,
      minDateIso: toIsoDate(new Date()),
    }),
  });
}

async function askAdults(chatId: ChatId): Promise<void> {
  const session = ensureSession(chatId);
  session.step = 'adults';
  const buttons: InlineKeyboardButton[][] = [];
  for (let value = 1; value <= Math.min(maxPassengers, 10); value += 1) {
    const rowIndex = Math.floor((value - 1) / 5);
    buttons[rowIndex] ??= [];
    buttons[rowIndex].push({ text: String(value), callback_data: `p:${value}` });
  }

  await bot.sendMessage(chatId, 'Neçə nəfərlik axtaraq?', {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showTicketTypeSelector(chatId: ChatId, editMessageId?: number): Promise<void> {
  const session = ensureSession(chatId);
  session.step = 'ticketTypes';

  const buttons = TICKET_TYPE_OPTIONS.map((ticketType) => [{
    text: `${session.selectedTicketTypeIds.has(ticketType.id) ? '✓ ' : ''}${ticketType.label}`,
    callback_data: `tt:toggle:${ticketType.id}`,
  }]);

  buttons.push([{ text: 'Hazır', callback_data: 'tt:done' }]);

  const selected = formatSelectedTicketTypes(session.selectedTicketTypeIds) || 'yoxdur';
  await sendOrEdit(chatId, editMessageId, [
    'Hansı zal tipini axtaraq?',
    'Bir və ya bir neçə seçim edə bilərsən.',
    `Seçilənlər: ${selected}`,
  ].join('\n'), {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showConfirm(chatId: ChatId, session: BotSession): Promise<void> {
  const request = buildRequest(session);
  const lines = [
    'Sorğunu təsdiqlə:',
    `${request.from.label} -> ${request.to.label}`,
    `Tək gediş tarixləri: ${request.targetDates.join(', ')}`,
    `Sərnişin: ${request.adults}`,
    `Zal tipi: ${formatTicketTypes(request.ticketTypes)}`,
    '',
    'Monitorinq hər 5 dəqiqədən bir yoxlayacaq.',
  ];

  await bot.sendMessage(chatId, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Başlat', callback_data: 'confirm:start' }],
        [{ text: 'Ləğv et', callback_data: 'confirm:cancel' }],
      ],
    },
  });
}

async function startMonitoring(chatId: ChatId, user: User, session: BotSession): Promise<void> {
  const request = buildRequest(session);
  const subscription = jobManager.subscribe(request, {
    chatId,
    userId: user.id,
    username: user.username,
    ticketTypes: request.ticketTypes,
  });
  sessions.delete(String(chatId));

  const status = subscription.created
    ? 'Yeni ADY monitorinqi başladı.'
    : 'Bu sorğu artıq izlənirdi; səni həmin monitorinqə əlavə etdim.';
  await bot.sendMessage(chatId, [
    status,
    `${request.from.label} -> ${request.to.label}`,
    `Tək gediş tarixləri: ${request.targetDates.join(', ')}`,
    `Sərnişin: ${request.adults}, zal tipi: ${formatTicketTypes(request.ticketTypes)}`,
    `Axtarış limiti: ${subscription.job.subscribers.get(String(chatId))?.maxChecks ?? 24} yoxlama`,
    `Aktiv subscriber sayı: ${subscription.subscriberCount}`,
    '',
    'Dayandırmaq üçün /stop yaz.',
  ].join('\n'));
}

function hasMatchingTicket(batch: CheckBatch, selectedTicketTypes: string[]): boolean {
  return batch.results.some((result): result is TicketsFoundResult => (
    result.status === 'tickets-found' && ticketTypesMatch(result.ticketTypes, selectedTicketTypes)
  ));
}

function ticketTypesMatch(availableTicketTypes: string[], selectedTicketTypes: string[]): boolean {
  if (selectedTicketTypes.length === 0) return true;
  const selected = new Set(selectedTicketTypes.map(canonicalTicketType));
  return availableTicketTypes.some((ticketType) => selected.has(canonicalTicketType(ticketType)));
}

function buildNoTicketsMessage(
  request: AdyRequest,
  batch: CheckBatch,
  subscriber: AdySubscriber,
  nextCheckInMs: number,
  expired: boolean,
): string {
  const checkedDates = batch.results.map((result) => result.target.displayValue).join(', ');
  const remainingChecks = Math.max(0, subscriber.maxChecks - subscriber.checksCompleted);
  const retryLine = expired
    ? 'Bu yoxlamanı etdim, uyğun bilet tapılmadı. Axtarış limiti bitdi və monitorinq dayandırıldı.'
    : `Bu yoxlamanı etdim, uyğun bilet tapılmadı. ${formatRetryDelay(nextCheckInMs)} sonra yenidən yoxlayacam. Qalan yoxlama sayı: ${remainingChecks}.`;

  return [
    'ADY axtarışı edildi.',
    `${request.from.label || request.from.exact} -> ${request.to.label || request.to.exact}`,
    `Tarixlər: ${checkedDates || request.targetDates.map((target) => target.displayValue).join(', ')}`,
    `${request.adults} nəfər, zal tipi: ${formatTicketTypes(subscriber.ticketTypes)}`,
    `Yoxlama limiti: ${subscriber.checksCompleted}/${subscriber.maxChecks}`,
    '',
    retryLine,
  ].join('\n');
}

function buildCheckFailedMessage(
  request: AdyRequest,
  subscriber: AdySubscriber,
  nextCheckInMs: number,
  expired: boolean,
): string {
  const remainingChecks = Math.max(0, subscriber.maxChecks - subscriber.checksCompleted);
  const retryLine = expired
    ? 'Bu yoxlamanı etdim, uyğun bilet tapılmadı. Axtarış limiti bitdi və monitorinq dayandırıldı.'
    : `Bu yoxlamanı etdim, uyğun bilet tapılmadı. ${formatRetryDelay(nextCheckInMs)} sonra yenidən yoxlayacam. Qalan yoxlama sayı: ${remainingChecks}.`;

  return [
    'ADY axtarışı edildi.',
    `${request.from.label || request.from.exact} -> ${request.to.label || request.to.exact}`,
    `Tarixlər: ${request.targetDates.map((target) => target.displayValue).join(', ')}`,
    `${request.adults} nəfər, zal tipi: ${formatTicketTypes(subscriber.ticketTypes)}`,
    `Yoxlama limiti: ${subscriber.checksCompleted}/${subscriber.maxChecks}`,
    '',
    retryLine,
  ].join('\n');
}

function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

function parseTicketTypeId(value: string): TicketTypeId | null {
  return TICKET_TYPE_OPTIONS.some((ticketType) => ticketType.id === value) ? value as TicketTypeId : null;
}

function parseTicketTypeText(value: string): TicketTypeId[] {
  const normalizedValue = normalizeTicketType(value);
  return TICKET_TYPE_OPTIONS
    .filter((ticketType) => ticketType.aliases.some((alias) => normalizedValue.includes(normalizeTicketType(alias))))
    .map((ticketType) => ticketType.id);
}

function getSelectedTicketTypeLabels(selectedIds: Set<TicketTypeId>): string[] {
  return TICKET_TYPE_OPTIONS
    .filter((ticketType) => selectedIds.has(ticketType.id))
    .map((ticketType) => ticketType.label);
}

function formatSelectedTicketTypes(selectedIds: Set<TicketTypeId>): string {
  return formatTicketTypes(getSelectedTicketTypeLabels(selectedIds));
}

function formatTicketTypes(ticketTypes: string[]): string {
  return ticketTypes.length > 0 ? ticketTypes.join(', ') : '';
}

function normalizeTicketType(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[əƏ]/g, 'e')
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[şŞ]/g, 's')
    .replace(/[çÇ]/g, 'c')
    .replace(/[öÖ]/g, 'o')
    .replace(/[üÜ]/g, 'u')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\+\s*/g, '+')
    .trim();
}

function canonicalTicketType(value: string): string {
  const normalized = normalizeTicketType(value);
  if (normalized === 'komfort') return 'komfort+';
  return normalized;
}

function formatRetryDelay(delayMs: number): string {
  const totalSeconds = Math.max(1, Math.round(delayMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} saniyə`;

  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  return `${minutes} dəqiqə`;
}

function buildRequest(session: BotSession) {
  const from = getStationById(session.fromStationId ?? '');
  const to = getStationById(session.toStationId ?? '');
  const ticketTypes = getSelectedTicketTypeLabels(session.selectedTicketTypeIds);
  if (!from || !to || session.adults == null || ticketTypes.length === 0) {
    throw new Error('Sorğu tamamlanmayıb.');
  }

  return {
    from,
    to,
    targetDates: [...session.selectedDates].sort(),
    adults: session.adults,
    maxPrice: Number.MAX_SAFE_INTEGER,
    ticketTypes,
  };
}

function getStationsForField(field: StationField): AdyStation[] {
  const allowedIds = getAllowedStationIds(field);
  return ADY_STATIONS.filter((station) => allowedIds.includes(station.id));
}

function getAllowedStationIds(field: StationField): readonly string[] {
  if (field === 'from') return ADY_FROM_STATION_IDS;
  return ADY_TO_STATION_IDS;
}

function isStationAllowedForField(field: StationField, station: AdyStation): boolean {
  return getStationsForField(field).some((allowedStation) => allowedStation.id === station.id);
}

function matchStationForField(field: StationField, text: string): AdyStation | null {
  const station = matchStationText(text);
  if (!station || !isStationAllowedForField(field, station)) return null;
  return station;
}

function stationHelpText(field: StationField): string {
  if (field === 'from') {
    return 'Bu istiqamət üçün başlanğıc yalnız bunlardan biri ola bilər: Bakı, Biləcəri, Yevlax, Gəncə, Ağstafa, Böyük-Kəsik.';
  }

  return 'Bu istiqamət üçün son məntəqə yalnız Tbilisi-Sərn və ya Qardabani ola bilər.';
}

function createSession(): BotSession {
  return {
    service: 'ady',
    step: 'service',
    fromStationId: null,
    toStationId: null,
    selectedDates: new Set(),
    calendarCursor: currentMonthCursor(),
    adults: null,
    selectedTicketTypeIds: new Set(),
  };
}

function ensureSession(chatId: ChatId): BotSession {
  const key = String(chatId);
  if (!sessions.has(key)) {
    sessions.set(key, createSession());
  }
  return sessions.get(key) as BotSession;
}

async function sendOrEdit(
  chatId: ChatId,
  messageId: number | undefined,
  text: string,
  options: ReplyMarkupOptions = {},
): Promise<void> {
  if (!messageId) {
    await bot.sendMessage(chatId, text, options);
    return;
  }

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    ...options,
  }).catch(async (error: Error) => {
    if (!String(error.message || '').includes('message is not modified')) {
      await bot.sendMessage(chatId, text, options);
    }
  });
}

async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await bot.answerCallbackQuery(callbackQueryId, text ? { text } : undefined).catch(() => {});
}

function parseStationField(value: string | undefined): StationField | null {
  return value === 'from' || value === 'to' ? value : null;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowed(chatId: ChatId): boolean {
  return allowedChatIds.length === 0 || allowedChatIds.includes(String(chatId));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function shutdown(): Promise<void> {
  await jobManager.close();
  process.exit(0);
}
