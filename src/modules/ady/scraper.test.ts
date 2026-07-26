import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTicketSearchUrl,
  createScrapeKey,
  normalizeRequest,
  parseTargetDate,
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
