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
- `ADY_URL`
- `ADY_INTERVAL_MS`
- `ADY_RESULT_WAIT_MS`
- `ADY_HEADLESS`
- `ADY_BROWSER_CHANNEL`
- `ADY_BROWSER_PROFILE_DIR`
- `ADY_ARTIFACTS_DIR`
- `ADY_BOT_MAX_CONCURRENT_CHECKS`
- `ADY_BOT_MAX_CHECKS_PER_SUBSCRIPTION`
- `ADY_BOT_MAX_DATES`
- `ADY_BOT_MAX_PASSENGERS`
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
6. Sərnişin sayı
7. Maksimum qiymət
8. Təsdiq

Bot yalnız tək istiqaməti izləyir. Ona görə qayıdış tarixi seçilmir. Sadəcə gediş tarixləri seçilir və bu seçim multi ola bilər, amma maksimum 4 gün seçilə bilər.

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

Tbilisi/Qardabani -> Bakı istiqaməti botda seçilə bilmir.

Monitorinq hər `ADY_INTERVAL_MS` intervalında yoxlayır. Default `300000` ms-dir, yəni 5 dəqiqə.

Uyğun bilet tapılanda bot istifadəçiyə mesaj göndərir:

- marşrut
- sərnişin sayı
- seçilən tarix
- tapılan ən ucuz qiymət
- birbaşa bilet seçimi səhifəsinə aparan `ticket-search` linki

Eyni sorğunu bir neçə user seçəndə ayrıca scrape açılmır. Sorğu fingerprint-i bunlardan ibarətdir:

- haradan
- haraya
- seçilən tarixlər
- sərnişin sayı

Maksimum qiymət fingerprint-ə daxil edilmir. Beləliklə eyni scrape nəticəsi fərqli max qiymətli user-lər üçün təkrar istifadə olunur.

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

CLI rejimi hələ qalır, amma Telegram bot axınında marşrut, tarixlər, sərnişin sayı və maksimum qiymət userdən soruşulduğu üçün bu dəyərlər artıq `.env`-də saxlanılmır.

## Static ADY filterləri

Telegram botdakı stansiya siyahısı `src/modules/ady/stations.ts` içində statik saxlanılır. Siyahı ADY dropdown-dan scrape olunub və exact label-lar saxlanılıb ki, Playwright seçimi saytdakı real option text-lə işləsin.

Qeyd: sayt Cloudflare istifadə edir. Ona görə browser default olaraq görünən rejimdə açılır (`ADY_HEADLESS=false`) və `.browser-profile` qovluğunda sessiyanı saxlayır.

## Docker deploy

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

GitHub Actions deploy needs these repository secrets:

- `DEPLOY_HOST` - server IP, for example `169.58.0.129`
- `DEPLOY_USER` - usually `root`
- `DEPLOY_SSH_KEY` - private key contents for `C:\Users\Mirafgan\.ssh\ady_bot_169_58_0_129.pem`

Keep Telegram and ADY runtime settings only on the server in `/opt/ady-ticket-bot/.env`.
