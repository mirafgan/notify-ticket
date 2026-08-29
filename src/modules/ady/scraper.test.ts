import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createScrapeKey,
    normalizeRequest,
    parseTargetDate,
    parseTicketPrice,
    summarizeBatchForMaxPrice,
} from './scraper';
import {getTicketDestinationStationIds} from './stations';

const baseRequest = {
  from: { id: 'baki-dyv' },
  to: { id: 'tbilisi-sern' },
  targetDates: '2026-07-31',
  adults: 3,
  infant: 1,
  child: 4,
  maxPrice: 100,
};

test('allows every other supported ADY station as Tbilisi-Sərn destination', () => {
  assert.deepEqual(getTicketDestinationStationIds('tbilisi-sern'), [
    'baki-dyv',
    'bileceri',
    'yevlax',
    'gence',
    'agstafa',
    'boyuk-kesik',
    'qardabani',
  ]);
});

test('normalizes Telegram station IDs for the Playwright form', () => {
  const request = normalizeRequest(baseRequest);
  assert.equal(request.from.exact, 'BAKI DYV');
  assert.equal(request.from.query, 'BAKI');
  assert.equal(request.to.exact, 'TBİLİSİ-SƏRN');
  assert.equal(request.to.query, 'TBİLİSİ');
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

test('does not report an unknown browser result as no ticket', () => {
  const request = normalizeRequest(baseRequest);
  const result = summarizeBatchForMaxPrice({
    ok: true,
    status: 'checked',
    request,
    results: [{
      ok: false,
      target: parseTargetDate('2026-07-31'),
      status: 'unknown',
      message: 'Axtarış nəticəsi hələ yüklənməyib.',
    }],
  }, request);

  assert.equal(result.status, 'unknown');
  assert.match(result.message, /nəticəsi tam müəyyən olmadı/);
});

test('parses the displayed ticket price text', () => {
  assert.equal(parseTicketPrice('  213.46 AZN  '), 213.46);
  assert.equal(parseTicketPrice('1 213,46 AZN'), 1213.46);
  assert.equal(parseTicketPrice('Qiymət göstərilməyib'), null);
});
