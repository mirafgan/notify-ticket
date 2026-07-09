import type { InlineKeyboardMarkup } from 'node-telegram-bot-api';

export interface CalendarCursor {
  year: number;
  month: number;
}

interface CalendarKeyboardOptions {
  minDateIso?: string;
  maxSelectedDates?: number;
}

const MONTH_NAMES = [
  'Yanvar',
  'Fevral',
  'Mart',
  'Aprel',
  'May',
  'İyun',
  'İyul',
  'Avqust',
  'Sentyabr',
  'Oktyabr',
  'Noyabr',
  'Dekabr',
] as const;

const WEEK_DAYS = ['Be', 'Ça', 'Çə', 'Ca', 'Cü', 'Şə', 'Ba'] as const;

export function currentMonthCursor(date = new Date()): CalendarCursor {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  };
}

export function parseCursor(value: string): CalendarCursor {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return currentMonthCursor();

  return {
    year: Number(match[1]),
    month: Number(match[2]),
  };
}

export function cursorToValue(cursor: CalendarCursor): string {
  return `${cursor.year}-${pad(cursor.month)}`;
}

export function shiftMonth(cursor: CalendarCursor, delta: number): CalendarCursor {
  const date = new Date(cursor.year, cursor.month - 1 + delta, 1);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  };
}

export function buildCalendarKeyboard(
  cursor: CalendarCursor,
  selectedDates: ReadonlySet<string>,
  options: CalendarKeyboardOptions = {},
): InlineKeyboardMarkup {
  const selected = new Set(selectedDates);
  const minDateIso = options.minDateIso ?? toIsoDate(new Date());
  const maxSelectedDates = options.maxSelectedDates ?? 4;
  const previous = shiftMonth(cursor, -1);
  const next = shiftMonth(cursor, 1);
  const keyboard: InlineKeyboardMarkup['inline_keyboard'] = [
    [
      { text: '<', callback_data: `cal:nav:${cursorToValue(previous)}` },
      { text: `${MONTH_NAMES[cursor.month - 1]} ${cursor.year}`, callback_data: 'noop' },
      { text: '>', callback_data: `cal:nav:${cursorToValue(next)}` },
    ],
    WEEK_DAYS.map((day) => ({ text: day, callback_data: 'noop' })),
  ];

  const firstDay = new Date(cursor.year, cursor.month - 1, 1);
  const daysInMonth = new Date(cursor.year, cursor.month, 0).getDate();
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  let row: InlineKeyboardMarkup['inline_keyboard'][number] = [];

  for (let index = 0; index < mondayOffset; index += 1) {
    row.push({ text: ' ', callback_data: 'noop' });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${cursor.year}-${pad(cursor.month)}-${pad(day)}`;
    const isPast = iso < minDateIso;
    const isSelected = selected.has(iso);
    const isAtLimit = selected.size >= maxSelectedDates && !isSelected;
    const text = isSelected ? `[x] ${day}` : String(day);

    row.push({
      text: isPast ? ' ' : text,
      callback_data: isPast || isAtLimit ? 'noop' : `cal:t:${iso}`,
    });

    if (row.length === 7) {
      keyboard.push(row);
      row = [];
    }
  }

  if (row.length > 0) {
    while (row.length < 7) {
      row.push({ text: ' ', callback_data: 'noop' });
    }
    keyboard.push(row);
  }

  keyboard.push([
    { text: `Seçildi: ${selected.size}`, callback_data: 'noop' },
    { text: 'Bitir', callback_data: 'cal:done' },
  ]);

  return { inline_keyboard: keyboard };
}

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatSelectedDates(dates: Iterable<string>): string {
  return [...dates].sort().join(', ');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
