import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTicketSearchUrl,
  classifyTicketApiResult,
  createScrapeKey,
  normalizeRequest,
  parseTargetDate,
  summarizeBatchForMaxPrice,
} from './scraper';
import { getTicketStationId } from './stations';

const baseRequest = {
  from: { id: 'baki-dyv' },
  to: { id: 'tbilisi-sern' },
  targetDates: '2026-07-31',
  adults: 3,
  infant: 1,
  child: 4,
  maxPrice: 100,
};

test('builds a direct ticket-search URL with station IDs and passenger counts', () => {
  const url = new URL(buildTicketSearchUrl(baseRequest, parseTargetDate('2026-07-31')));

  assert.equal(url.pathname, '/az/ticket-search/baki-dyv-tbilisi-sern');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    from_station: '232',
    to_station: '170',
    date: '31/07/2026',
    return_date: '31/07/2026',
    two_way: 'false',
    child: '4',
    infant: '1',
    adults: '3',
  });
});

test('maps every Telegram station to its ADY ticket-search ID', () => {
  assert.deepEqual(
    Object.fromEntries([
      'baki-dyv',
      'bileceri',
      'yevlax',
      'gence',
      'agstafa',
      'boyuk-kesik',
      'tbilisi-sern',
      'qardabani',
    ].map((stationId) => [stationId, getTicketStationId(stationId)])),
    {
      'baki-dyv': 232,
      bileceri: 230,
      yevlax: 286,
      gence: 295,
      agstafa: 303,
      'boyuk-kesik': 309,
      'tbilisi-sern': 170,
      qardabani: 172,
    },
  );
});

test('builds a direct Tbilisi to Baku ticket-search URL', () => {
  const url = new URL(buildTicketSearchUrl({
    ...baseRequest,
    from: { id: 'tbilisi-sern' },
    to: { id: 'baki-dyv' },
  }, parseTargetDate('2026-07-31')));

  assert.equal(url.pathname, '/az/ticket-search/tbilisi-sern-baki-dyv');
  assert.equal(url.searchParams.get('from_station'), '170');
  assert.equal(url.searchParams.get('to_station'), '232');
});

test('enforces the four-seat rule for adults and children', () => {
  assert.equal(normalizeRequest(baseRequest).infant, 1);
  assert.throws(
    () => normalizeRequest({ ...baseRequest, adults: 3, infant: 2 }),
    /Uşaq \(10 yaşa qədər\) sayı 0-1/,
  );
  assert.throws(
    () => normalizeRequest({ ...baseRequest, adults: 5 }),
    /Böyük sərnişin sayı 1-4/,
  );
  assert.throws(
    () => normalizeRequest({ ...baseRequest, child: 5 }),
    /Körpə sayı 0-4/,
  );
});

test('keeps monitoring jobs separate for different passenger compositions', () => {
  const differentChildCount = { ...baseRequest, child: 3 };
  const differentInfantCount = { ...baseRequest, infant: 0 };

  assert.notEqual(createScrapeKey(baseRequest), createScrapeKey(differentChildCount));
  assert.notEqual(createScrapeKey(baseRequest), createScrapeKey(differentInfantCount));
});

test('does not report an unknown ADY result as no ticket', () => {
  const request = normalizeRequest(baseRequest);
  const result = summarizeBatchForMaxPrice({
    ok: true,
    status: 'checked',
    request,
    results: [{
      ok: false,
      target: parseTargetDate('2026-07-31'),
      status: 'unknown',
      message: 'ADY bilet API xətası (422): ReCaptcha validation failed.',
    }],
  }, request);

  assert.equal(result.status, 'unknown');
  assert.match(result.message, /nəticəsi tam müəyyən olmadı/);
});

test('distinguishes an empty ADY result from a ReCaptcha failure', () => {
  assert.deepEqual(
    classifyTicketApiResult(200, { error: true, message: 'Boş yer yoxdur' }),
    { status: 'sold-out', message: 'Uyğun bilet yoxdur: Boş yer yoxdur.' },
  );
  assert.deepEqual(
    classifyTicketApiResult(422, { error: true, message: 'ReCaptcha validation failed' }),
    { status: 'unknown', message: 'ADY bilet API xətası (422): ReCaptcha validation failed.' },
  );
});
