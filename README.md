# ADY Ticket Monitor

Bu layihə `https://ticket.ady.az/` üçün ADY bilet monitorinqidir. Əvvəlki CLI script saxlanılıb, əlavə olaraq Telegram bot rejimi var.

## Qurulum

```powershell
npm.cmd install
```

`.env.example` faylını `.env` kimi kopyala və dəyərləri doldur.

TypeScript yoxlama və build:

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Telegram bot üçün minimum:

```powershell
TELEGRAM_BOT_TOKEN=123456:telegram-token
```

İstəsən botu yalnız konkret chat-lar üçün aç:

```powershell
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

Bot üçün `.env`-də saxlanan parametrlər:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `ADY_BOT_CAPTCHA_ALERT_CHAT_ID` (422/ReCaptcha olduqda xəbərdarlıq göndəriləcək idarəetmə chat ID-si)
- `ADY_BOT_REMOTE_DESKTOP_URL` (CAPTCHA xəbərdarlığındakı private noVNC linki)
- `ADY_URL`
- `ADY_INTERVAL_MS`
- `ADY_RESULT_WAIT_MS`
- `ADY_HEADLESS`
- `ADY_BROWSER_CHANNEL`
- `ADY_BROWSER_CDP_URL` (istəyə bağlı: istifadəçinin açdığı Chrome-a CDP ilə qoşulmaq üçün)
- `ADY_BROWSER_PROFILE_DIR`
- `ADY_BROWSER_PROXY_SERVER` (istəyə bağlı: Chrome-un istifadə edəcəyi SOCKS5/HTTP proxy)
- `ADY_ARTIFACTS_DIR`
- `ADY_PAGE_DIAGNOSTICS_ENABLED`
- `ADY_PAGE_DIAGNOSTICS_TEXT_LIMIT`
- `ADY_ADULTS` (CLI: 1-4)
- `ADY_INFANT` (CLI: Uşaq, 10 yaşa qədər)
- `ADY_CHILD` (CLI: Körpə)
- `ADY_BOT_MAX_CONCURRENT_CHECKS`
- `ADY_BOT_MAX_CHECKS_PER_SUBSCRIPTION`
- `ADY_BOT_MAX_DATES`
- `ADY_BOT_STATIONS_PER_PAGE`
- `ADY_BOT_STOP_ON_AVAILABLE`
- `ADY_BOT_SCREENSHOTS_ENABLED`

## Telegram bot

```powershell
npm.cmd run bot
```

Bot axını:

1. `/start`
2. `ADY.az` seçimi
3. Haradan stansiyası
4. Haraya stansiyası
5. Calendar üzərindən 1-4 arası gediş tarixi
6. Böyük sərnişin sayı (1-4)
7. Uşaq sayı, 10 yaşa qədər (Böyük + Uşaq maksimum 4)
8. Körpə sayı (0-4)
9. Zal tipi: Komfort, Komfort+, Lüks, Standart+
10. Təsdiq

Bot yalnız tək istiqaməti izləyir. Ona görə qayıdış tarixi seçilmir. Sadəcə gediş tarixləri seçilir və bu seçim multi ola bilər, amma maksimum 10 gün seçilə bilər.

İcazəli başlanğıc stansiyaları:

- Bakı
- Biləcəri
- Yevlax
- Gəncə
- Ağstafa
- Böyük-Kəsik

İcazəli son məntəqələr:

- Tbilisi-Sərn
- Qardabani

Bot həm Azərbaycan stansiyalarından Tbilisi-Sərn/Qardabani istiqamətini, həm də Tbilisi-Sərn və Qardabanidən Bakı istiqamətini dəstəkləyir.

Monitorinq hər `ADY_INTERVAL_MS` intervalında yoxlayır. Default `300000` ms-dir, yəni 5 dəqiqə.

Sərnişin URL parametrləri ADY-nin istifadə etdiyi adlarla ötürülür: `adults` — Böyük, `infant` — 10 yaşa qədər Uşaq, `child` — Körpə. Böyük sayı 1-4, Uşaq sayı `0-(4 - Böyük)`, Körpə sayı isə 0-4 arası seçilir.

Uyğun bilet tapılanda bot istifadəçiyə mesaj göndərir:

- marşrut
- sərnişin sayı
- seçilən tarix
- uyğun zal tipi
- varsa tapılan ən ucuz qiymət
- birbaşa bilet seçimi səhifəsinə aparan `ticket-search` linki

Eyni sorğunu bir neçə user seçəndə ayrıca scrape açılmır. Sorğu fingerprint-i bunlardan ibarətdir:

- haradan
- haraya
- seçilən tarixlər
- Böyük, Uşaq və Körpə sayı

Zal tipi fingerprint-ə daxil edilmir. Beləliklə eyni scrape nəticəsi fərqli zal tipi seçən user-lər üçün təkrar istifadə olunur.

ADY-yə yük düşməməsi üçün eyni anda işləyən unikal scrape sayı limitlənir:

```powershell
ADY_BOT_MAX_CONCURRENT_CHECKS=2
```

Hər user abunəliyi üçün maksimum yoxlama sayı da limitlənir. Default `24` yoxlamadır. Default 5 dəqiqəlik interval ilə bu təxminən 2 saat edir:

```powershell
ADY_BOT_MAX_CHECKS_PER_SUBSCRIPTION=24
```

## CLI monitor

Bir dəfə yoxlama:

```powershell
npm.cmd run check
```

5 dəqiqəlik monitor:

```powershell
npm.cmd start
```

CLI rejimi hələ qalır. Telegram bot axınında marşrut, tarixlər, sərnişin sayı və zal tipi userdən soruşulur; CLI üçün sərnişin sayları `.env`-də `ADY_ADULTS`, `ADY_INFANT`, `ADY_CHILD` ilə verilə bilər.

## Static ADY filterləri

Telegram botdakı stansiya siyahısı `src/modules/ady/stations.ts` içində statik saxlanılır. Bot yalnız sənəddəki 8 stansiyanı göstərir və Playwright həmin stansiyaların ADY formundakı dəqiq mətnini seçir.

Yoxlama zamanı Playwright ADY-nin ana səhifəsini açır, formda stansiyaları, gediş tarixini və sərnişin saylarını seçib `Axtar` düyməsini basır. Bot nəticəni səhifədə görünən "Qatar seçimi" bölməsindən oxuyur; "Bütün biletlər satılıb" modalı görünərsə bunu uyğun bilet olmadığı kimi qəbul edir. Birbaşa `ticket-search` URL-i açılmır.

Qeyd: sayt Cloudflare istifadə edir. Ona görə browser default olaraq görünən rejimdə açılır (`ADY_HEADLESS=false`) və `.browser-profile` qovluğunda sessiyanı saxlayır.

ADY görünməz ReCaptcha yoxlamasında Playwright sessiyasını rədd etsə, Chrome-u ayrı proses kimi remote debugging ilə açıb botu ona qoşa bilərsən:

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --remote-debugging-port=9223 --user-data-dir="$PWD\.browser-profile"
$env:ADY_BROWSER_CDP_URL='http://127.0.0.1:9223'
npm.cmd run check
```

## Docker deploy

Docker image normal Google Chrome prosesini başladır və bot ona CDP vasitəsilə qoşulur. Bu, ADY-nin Playwright-in birbaşa yaratdığı sessiyalar üçün qaytardığı ReCaptcha xətasının qarşısını alır. Serverdə ayrıca `ADY_BROWSER_CDP_URL` yazmaq lazım deyil; yalnız container-dən kənar Chrome istifadə edilirsə həmin URL təyin olunur.

Chrome-un ekranı noVNC ilə container-də `6080` portunda işləyir. Docker bu portu yalnız serverin `127.0.0.1` ünvanına bağlayır; telefon üçün onu Tailscale Serve vasitəsilə private HTTPS link kimi paylaşın. `9222` Chrome debug portunu internetə açmayın.

Server layout:

```text
/opt/ady-ticket-bot/
  .env
  app/
  data/
    browser-profile/
    artifacts/
```

Manual run on the server:

```bash
cd /opt/ady-ticket-bot/app
docker compose --env-file /opt/ady-ticket-bot/.env up -d --build
docker compose logs -f ady-ticket-bot
```

Səhifə açılmasa və ya nəticə bilinməsə, Docker loglarında `[ADY diagnostic:...]` sətirləri çıxır. Bu loglarda cari URL, title, `.ticket__item` sayı, görünən loader, Cloudflare siqnalları, body text-in qısa hissəsi və diagnostic screenshot path-i görünür. Lazım olsa server `.env`-də `ADY_PAGE_DIAGNOSTICS_ENABLED=false` ilə söndürmək olar.

GitHub Actions deploy needs these repository secrets:

- `DEPLOY_HOST` - server IP, for example `169.58.0.129`
- `DEPLOY_USER` - usually `root`
- `DEPLOY_SSH_KEY` - private key contents for `C:\Users\Mirafgan\.ssh\ady_bot_169_58_0_129.pem`

Keep Telegram and ADY runtime settings only on the server in `/opt/ady-ticket-bot/.env`.
