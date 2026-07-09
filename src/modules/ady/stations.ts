export interface AdyStation {
  id: string;
  label: string;
  exact: string;
  query: string;
  country: string;
}

export const ADY_STATIONS_SCRAPED_AT = '2026-07-10';
export const ADY_STATIONS_SOURCE = 'https://ticket.ady.az/';

export const ADY_STATIONS = [
  { id: 'baki-dyv', label: 'Bakı', exact: 'BAKI DYV', query: 'BAKI', country: 'AZƏRBAYCAN' },
  { id: 'tbilisi-sern', label: 'Tbilisi-Sərn', exact: 'TBİLİSİ-SƏRN', query: 'TBİLİSİ', country: 'GÜRCÜSTAN' },
  { id: 'agdas', label: 'Ağdaş', exact: 'AĞDAŞ', query: 'AĞDAŞ', country: 'AZƏRBAYCAN' },
  { id: 'agstafa', label: 'Ağstafa', exact: 'AĞSTAFA', query: 'AĞSTAFA', country: 'AZƏRBAYCAN' },
  { id: 'balaken', label: 'Balakən', exact: 'BALAKƏN', query: 'BALAKƏN', country: 'AZƏRBAYCAN' },
  { id: 'boyuk-kesik', label: 'Böyük-Kəsik', exact: 'BÖYÜK-KƏSİK', query: 'BÖYÜK-KƏSİK', country: 'AZƏRBAYCAN' },
  { id: 'bileceri', label: 'Biləcəri', exact: 'BİLƏCƏRİ', query: 'BİLƏCƏRİ', country: 'AZƏRBAYCAN' },
  { id: 'deller', label: 'Dəllər', exact: 'DƏLLƏR', query: 'DƏLLƏR', country: 'AZƏRBAYCAN' },
  { id: 'dernegul', label: 'Dərnəgül', exact: 'DƏRNƏGÜL', query: 'DƏRNƏGÜL', country: 'AZƏRBAYCAN' },
  { id: 'goran', label: 'Goran', exact: 'GORAN', query: 'GORAN', country: 'AZƏRBAYCAN' },
  { id: 'goynuk', label: 'Göynük', exact: 'GÖYNÜK', query: 'GÖYNÜK', country: 'AZƏRBAYCAN' },
  { id: 'goyem', label: 'Göyəm', exact: 'GÖYƏM', query: 'GÖYƏM', country: 'AZƏRBAYCAN' },
  { id: 'gence', label: 'Gəncə', exact: 'GƏNCƏ', query: 'GƏNCƏ', country: 'AZƏRBAYCAN' },
  { id: 'kurdemir', label: 'Kürdəmir', exact: 'KÜRDƏMİR', query: 'KÜRDƏMİR', country: 'AZƏRBAYCAN' },
  { id: 'leki', label: 'Ləki', exact: 'LƏKİ', query: 'LƏKİ', country: 'AZƏRBAYCAN' },
  { id: 'qardabani', label: 'Qardabani', exact: 'QARDABANİ', query: 'QARDABANİ', country: 'GÜRCÜSTAN' },
  { id: 'qax', label: 'Qax', exact: 'QAX', query: 'QAX', country: 'AZƏRBAYCAN' },
  { id: 'qazax', label: 'Qazax', exact: 'QAZAX', query: 'QAZAX', country: 'AZƏRBAYCAN' },
  { id: 'qoragan', label: 'Qorağan', exact: 'QORAĞAN', query: 'QORAĞAN', country: 'AZƏRBAYCAN' },
  { id: 'qovlar', label: 'Qovlar', exact: 'QOVLAR', query: 'QOVLAR', country: 'AZƏRBAYCAN' },
  { id: 'qebele', label: 'Qəbələ', exact: 'QƏBƏLƏ', query: 'QƏBƏLƏ', country: 'AZƏRBAYCAN' },
  { id: 'tovuz', label: 'Tovuz', exact: 'TOVUZ', query: 'TOVUZ', country: 'AZƏRBAYCAN' },
  { id: 'ucar', label: 'Ucar', exact: 'UCAR', query: 'UCAR', country: 'AZƏRBAYCAN' },
  { id: 'yevlax', label: 'Yevlax', exact: 'YEVLAX', query: 'YEVLAX', country: 'AZƏRBAYCAN' },
  { id: 'zaqatala', label: 'Zaqatala', exact: 'ZAQATALA', query: 'ZAQATALA', country: 'AZƏRBAYCAN' },
  { id: 'sheki', label: 'Şəki', exact: 'ŞƏKİ', query: 'ŞƏKİ', country: 'AZƏRBAYCAN' },
  { id: 'eliabad', label: 'Əliabad', exact: 'ƏLİABAD', query: 'ƏLİABAD', country: 'AZƏRBAYCAN' },
] satisfies AdyStation[];

export function getStationById(id: string): AdyStation | null {
  return ADY_STATIONS.find((station) => station.id === id) ?? null;
}

export function stationDisplay(station: AdyStation): string {
  return `${station.label}, ${station.country}`;
}

export function matchStationText(text: string): AdyStation | null {
  const normalized = normalizeSearchText(text);
  if (!normalized) return null;

  return ADY_STATIONS.find((station) => {
    const values = [
      station.id,
      station.label,
      station.exact,
      station.country,
      stationDisplay(station),
    ];
    return values.some((value) => normalizeSearchText(value).includes(normalized));
  }) ?? null;
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLocaleUpperCase('az-AZ')
    .replace(/Ə/g, 'E')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/İ/g, 'I')
    .replace(/I/g, 'I')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
